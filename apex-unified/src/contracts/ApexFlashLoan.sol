// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

// Deploy to Base. Uses Balancer V2 flash loans (0% fee).
// Executes an arbitrary Uniswap V3 exactInput multi-hop path with borrowed funds.
// Path must start and end with the same token (flashToken) so the loan can be repaid.
// Profit is automatically split: taxBps% → taxWallet, remainder → owner.
//
// Hardening: inline reentrancy guard, pausable, approve-zero-first, configurable
// min profit, router whitelist, balance-based profit calculation, NatSpec.

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IUniswapV3Router {
    struct ExactInputParams {
        bytes   path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external returns (uint256 amountOut);
}

// Minimal IUniswapV3Pool surface needed for pre-flight price check.
// slot0() is the first storage slot in every Uni V3 / Aerodrome CL pool.
interface IUniV3Pool {
    /// @return sqrtPriceX96 Current sqrt price as Q64.96 fixed-point.
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24   tick,
        uint16  observationIndex,
        uint16  observationCardinality,
        uint16  observationCardinalityNext,
        uint8   feeProtocol,
        bool    unlocked
    );
}

// ─── Contract ────────────────────────────────────────────────────────────────

contract ApexFlashLoan {

    // ── Constants ─────────────────────────────────────────────────────────────

    /// @notice Balancer V2 Vault — same address on all EVM networks.
    address public constant VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    /// @notice Uniswap V3 SwapRouter02 on Base mainnet.
    address public constant DEFAULT_UNI_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;

    // ── Immutables ────────────────────────────────────────────────────────────

    /// @notice Contract owner; set once at deployment, never changes.
    address public immutable owner;

    // ── Reentrancy guard ──────────────────────────────────────────────────────

    /// @dev 1 = not entered, 2 = entered. Avoids extra SLOAD via bool reset trick.
    uint256 private _status = 1;

    // ── Pausable ──────────────────────────────────────────────────────────────

    /// @notice When true, `executeArbitrage` and `receiveFlashLoan` revert.
    bool public paused;

    // ── Profit split ──────────────────────────────────────────────────────────

    /// @notice Address that receives `taxBps` / 10 000 of every profit.
    address public taxWallet;

    /// @notice Basis points sent to taxWallet (e.g. 3000 = 30%).  Max 5000.
    uint256 public taxBps;

    // ── Min profit ────────────────────────────────────────────────────────────

    /// @notice Minimum net profit required before payout (in flash-token decimals).
    ///         Defaults to 1 000 (= 0.001 USDC with 6 decimals).  Owner-configurable.
    uint256 public minProfitUsdc = 1_000;

    // ── Router whitelist ──────────────────────────────────────────────────────

    /// @notice Only whitelisted routers may be used in `executeArbitrage`.
    mapping(address => bool) public approvedRouters;

    // ── Events ────────────────────────────────────────────────────────────────

    event PreflightRejected(address indexed pool, uint160 actual, uint160 expected, uint24 toleranceBps);

    event ArbitrageExecuted(
        address indexed token,
        uint256 amountIn,
        uint256 profit,
        uint256 taxAmount
    );
    event SplitUpdated(address taxWallet, uint256 taxBps);
    event PausedStateChanged(bool paused);
    event RouterUpdated(address indexed router, bool approved);
    event MinProfitUpdated(uint256 minProfit);
    event EmergencyWithdraw(address indexed token, uint256 amount, address indexed to);

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    /// @dev Inline CEI-style reentrancy guard (no OpenZeppelin dependency).
    modifier nonReentrant() {
        require(_status != 2, "Reentrant call");
        _status = 2;
        _;
        _status = 1;
    }

    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
        // Pre-approve Uniswap V3 SwapRouter02 on Base
        approvedRouters[DEFAULT_UNI_V3_ROUTER] = true;
        emit RouterUpdated(DEFAULT_UNI_V3_ROUTER, true);
    }

    // ─── Admin — profit split ─────────────────────────────────────────────────

    /// @notice Set the tax wallet and percentage.  Call once after deployment.
    /// @param _taxWallet  Address that receives the tax portion of every profit.
    /// @param _taxBps     Basis points to send to taxWallet (3000 = 30%, max 5000).
    function setSplit(address _taxWallet, uint256 _taxBps) external onlyOwner {
        require(_taxWallet != address(0), "Zero address");
        require(_taxBps <= 5000, "Max 50%");
        taxWallet = _taxWallet;
        taxBps    = _taxBps;
        emit SplitUpdated(_taxWallet, _taxBps);
    }

    // ─── Admin — pausable ─────────────────────────────────────────────────────

    /// @notice Pause or unpause arbitrage execution.
    /// @param _paused  True to pause; false to unpause.
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedStateChanged(_paused);
    }

    // ─── Admin — min profit ───────────────────────────────────────────────────

    /// @notice Update the minimum net profit threshold.
    /// @param _min  Minimum profit in flash-token base units.
    function setMinProfit(uint256 _min) external onlyOwner {
        minProfitUsdc = _min;
        emit MinProfitUpdated(_min);
    }

    // ─── Admin — router whitelist ─────────────────────────────────────────────

    /// @notice Add or remove a router from the whitelist.
    /// @param router    Router address.
    /// @param approved  True to whitelist; false to remove.
    function setRouter(address router, bool approved) external onlyOwner {
        require(router != address(0), "Zero address");
        approvedRouters[router] = approved;
        emit RouterUpdated(router, approved);
    }

    // ─── Pre-flight price guard ───────────────────────────────────────────────

    /// @dev Yul staticcall to pool.slot0(); reverts before Balancer is called so
    ///      a stale bundle costs ~3 000 gas instead of ~200 000.
    ///      Called ONLY from executeArbitrageWithPreflight — never from the callback.
    ///
    /// @param pool              Uniswap V3 (or compatible) pool address.
    /// @param expectedSqrtPrice Off-chain snapshot of pool.slot0().sqrtPriceX96.
    /// @param toleranceBps      Max acceptable deviation in basis points (e.g. 50).
    function _assertPriceInBounds(
        address pool,
        uint160 expectedSqrtPrice,
        uint24  toleranceBps
    ) internal {
        require(pool != address(0),      "Preflight: zero pool");
        require(expectedSqrtPrice > 0,   "Preflight: zero expected price");
        require(toleranceBps <= 500,     "Preflight: tolerance >5%");

        // ── Yul: staticcall pool.slot0() selector = 0x3850c7bd ───────────────
        // Uses inline assembly to avoid Solidity's ABI decoder overhead and to
        // stay on the cold-call gas path (no memory expansion beyond scratchpad).
        uint160 actualSqrtPrice;
        assembly ("memory-safe") {
            // Scratch space: write the 4-byte selector at offset 0x00
            mstore(0x00, 0x3850c7bd00000000000000000000000000000000000000000000000000000000)

            // staticcall(gas, addr, argsOffset, argsLen, retOffset, retLen)
            // slot0 returns 7 values; we only need the first (sqrtPriceX96 = uint160).
            // Allocate 0xe0 (224 bytes) return space starting at 0x20.
            let ok := staticcall(gas(), pool, 0x00, 0x04, 0x20, 0xe0)
            if iszero(ok) {
                // Pool call failed — revert cheaply; the bundle is already bad.
                mstore(0x00, 0x08c379a000000000000000000000000000000000000000000000000000000000) // Error(string)
                mstore(0x04, 0x20)
                mstore(0x24, 0x11)  // length = 17
                mstore(0x44, 0x507265666c696768743a20736c6f7430206661696c65640000000000000000000) // "Preflight: slot0 failed"
                revert(0x00, 0x64)
            }
            // First 32-byte word at 0x20 contains sqrtPriceX96 (right-padded uint160)
            actualSqrtPrice := mload(0x20)
        }

        // ── Tolerance check in Solidity (cheaper than Yul here: no overflow risk) ──
        uint256 diff   = actualSqrtPrice > expectedSqrtPrice
            ? actualSqrtPrice - expectedSqrtPrice
            : expectedSqrtPrice - actualSqrtPrice;
        uint256 maxDev = (uint256(expectedSqrtPrice) * toleranceBps) / 10_000;

        if (diff > maxDev) {
            emit PreflightRejected(pool, actualSqrtPrice, expectedSqrtPrice, toleranceBps);
            revert("Preflight: price stale");
        }
    }

    // ─── External entry point ─────────────────────────────────────────────────

    /// @notice Initiate a Balancer V2 flash loan and execute a UniV3 multi-hop arb.
    ///         The entire round-trip (borrow → swap → repay → split) is atomic.
    /// @param flashToken    Token to borrow (e.g. USDC on Base).
    /// @param flashAmount   Amount to borrow (in token base units).
    /// @param uniV3Router   Uniswap V3 SwapRouter02 address (must be whitelisted).
    /// @param path          ABI-packed multi-hop path: addr|fee|addr|fee|…|addr.
    ///                      Must start AND end with `flashToken`.
    /// @param minAmountOut  Minimum tokens returned from the swap (slippage guard).
    function executeArbitrage(
        address flashToken,
        uint256 flashAmount,
        address uniV3Router,
        bytes calldata path,
        uint256 minAmountOut
    ) external onlyOwner whenNotPaused {
        // nonReentrant intentionally omitted here: adding it would deadlock the
        // Balancer callback (receiveFlashLoan runs inside this call stack with
        // _status already set to 2). Access is already restricted to owner.
        // receiveFlashLoan carries the nonReentrant guard instead.
        require(approvedRouters[uniV3Router], "Router not approved");
        require(flashToken != address(0), "Zero token");
        require(flashAmount > 0, "Zero amount");

        // Path must round-trip: start AND end with flashToken so the loan can
        // be repaid. Minimum single-hop path is addr(20) + fee(3) + addr(20).
        require(path.length >= 43, "Path too short");
        require(address(bytes20(path[:20])) == flashToken, "Path must start with flashToken");
        require(address(bytes20(path[path.length - 20:])) == flashToken, "Path must end with flashToken");

        address[] memory tokens  = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0]  = flashToken;
        amounts[0] = flashAmount;

        bytes memory userData = abi.encode(
            uniV3Router, path, flashAmount, flashToken, minAmountOut
        );
        IBalancerVault(VAULT).flashLoan(address(this), tokens, amounts, userData);
    }

    // ─── Guarded entry point (pre-flight price check) ────────────────────────

    /// @notice Like executeArbitrage but verifies pool price has not moved beyond
    ///         toleranceBps before initiating the flash loan.
    ///
    ///         Pre-flight reverts at ~3 000 gas (staticcall + compare + revert)
    ///         instead of ~200 000 gas if the swap itself reverts on stale quotes.
    ///
    ///         On Base, where txs are ordered by priority fee + arrival time rather
    ///         than a competitive builder auction, this guard prevents wasted gas on
    ///         bundles built from quotes that aged out during the 2-second block window.
    ///
    /// @param priceCheckPool    Pool whose slot0() sqrtPriceX96 is verified.
    ///                          Pass address(0) to disable the check (identical to
    ///                          calling executeArbitrage directly).
    /// @param expectedSqrtPrice Off-chain snapshot of slot0().sqrtPriceX96.
    /// @param toleranceBps      Acceptable drift, e.g. 50 = 0.5%.  Max 500.
    function executeArbitrageWithPreflight(
        address  flashToken,
        uint256  flashAmount,
        address  uniV3Router,
        bytes calldata path,
        uint256  minAmountOut,
        address  priceCheckPool,
        uint160  expectedSqrtPrice,
        uint24   toleranceBps
    ) external onlyOwner whenNotPaused {
        // Pre-flight: revert here (< 3 000 gas) rather than deep inside Balancer
        if (priceCheckPool != address(0)) {
            _assertPriceInBounds(priceCheckPool, expectedSqrtPrice, toleranceBps);
        }

        require(approvedRouters[uniV3Router], "Router not approved");
        require(flashToken  != address(0),    "Zero token");
        require(flashAmount  > 0,             "Zero amount");
        require(path.length >= 43,            "Path too short");
        require(address(bytes20(path[:20]))              == flashToken, "Path must start with flashToken");
        require(address(bytes20(path[path.length - 20:])) == flashToken, "Path must end with flashToken");

        address[] memory tokens  = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0]  = flashToken;
        amounts[0] = flashAmount;

        bytes memory userData = abi.encode(
            uniV3Router, path, flashAmount, flashToken, minAmountOut
        );
        IBalancerVault(VAULT).flashLoan(address(this), tokens, amounts, userData);
    }

    // ─── Balancer flash loan callback ─────────────────────────────────────────

    /// @notice Called by the Balancer Vault after transferring the flash loan.
    ///         Executes the multi-hop swap, repays the loan, and splits the profit.
    ///         Reverts if profit is below `minProfitUsdc`.
    /// @dev Only callable by the Balancer Vault.  Protected by reentrancy guard
    ///      and pause switch.  All state changes precede external calls.
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts, // currently 0 on Balancer V2; included for forward-compat
        bytes memory userData
    ) external nonReentrant whenNotPaused {
        // ── Caller validation ────────────────────────────────────────────────
        require(msg.sender == VAULT, "Only Balancer Vault");

        // ── Payload validation ───────────────────────────────────────────────
        require(tokens.length == 1,  "Single token only");
        require(amounts.length == 1, "Single amount only");
        require(amounts[0] > 0,      "Zero amount");

        (
            address uniV3Router,
            bytes memory path,
            uint256 flashAmount,
            address flashToken,
            uint256 minAmountOut
        ) = abi.decode(userData, (address, bytes, uint256, address, uint256));

        require(approvedRouters[uniV3Router], "Router not approved");

        // ── Execute the multi-hop swap ───────────────────────────────────────
        // Approve zero first to prevent the ERC-20 approve race condition.
        IERC20(flashToken).approve(uniV3Router, 0);
        IERC20(flashToken).approve(uniV3Router, amounts[0]);

        IUniswapV3Router(uniV3Router).exactInput(
            IUniswapV3Router.ExactInputParams({
                path:             path,
                recipient:        address(this),
                amountIn:         amounts[0],
                amountOutMinimum: minAmountOut
            })
        );

        // ── Balance-based profit calculation ─────────────────────────────────
        // After the swap the contract holds the output tokens.  We borrowed
        // `flashAmount` and the swap result must exceed that to be profitable.
        // Using balanceOf (rather than relying on amountOut) defends against
        // fee-on-transfer tokens and router rounding.
        uint256 finalBalance = IERC20(flashToken).balanceOf(address(this));
        uint256 repayment = flashAmount + feeAmounts[0];
        require(finalBalance >= repayment, "Cannot repay loan");
        uint256 profit = finalBalance - repayment;
        require(profit >= minProfitUsdc, "Below min profit");

        // ── Repay Balancer ────────────────────────────────────────────────────
        require(
            IERC20(flashToken).transfer(VAULT, repayment),
            "Repay failed"
        );

        // ── Auto profit split ────────────────────────────────────────────────
        uint256 taxAmount = 0;
        if (taxWallet != address(0) && taxBps > 0) {
            taxAmount = (profit * taxBps) / 10_000;
            if (taxAmount > 0) {
                require(
                    IERC20(flashToken).transfer(taxWallet, taxAmount),
                    "Tax transfer failed"
                );
            }
        }

        require(
            IERC20(flashToken).transfer(owner, profit - taxAmount),
            "Owner transfer failed"
        );

        emit ArbitrageExecuted(flashToken, flashAmount, profit, taxAmount);
    }

    // ─── Owner utilities ──────────────────────────────────────────────────────

    /// @notice Rescue any ERC-20 token stuck in this contract.
    ///         Transfers the full balance to the owner.
    /// @param token  ERC-20 token address to rescue.
    function withdraw(address token) external onlyOwner nonReentrant {
        require(token != address(0), "Zero address");
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "Nothing to withdraw");
        require(IERC20(token).transfer(owner, bal), "Transfer failed");
        emit EmergencyWithdraw(token, bal, owner);
    }

    /// @notice Rescue native ETH accidentally sent to this contract.
    function withdrawETH() external onlyOwner nonReentrant {
        uint256 bal = address(this).balance;
        require(bal > 0, "No ETH to withdraw");
        (bool success, ) = payable(owner).call{value: bal}("");
        require(success, "ETH transfer failed");
        emit EmergencyWithdraw(address(0), bal, owner);
    }

    /// @dev Accept ETH (e.g. from accidental transfers).
    receive() external payable {}
}
