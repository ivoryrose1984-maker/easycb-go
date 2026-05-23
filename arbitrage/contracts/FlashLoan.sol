// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// filepath: contracts/FlashLoan.sol
// Deploy to Base mainnet. Uses Balancer V2 flash loans (0% fee).
// Profit is automatically split: taxBps% → taxWallet, remainder → owner.
//
// Hardening: inline reentrancy guard, pausable, approve-zero-first, configurable
// min profit, balance-based profit calculation, full NatSpec.

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
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external returns (uint256 amountOut);
}

interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool    stable;
        address factory;
    }
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

// ─── Contract ────────────────────────────────────────────────────────────────

contract ApexFlashLoan {

    // ── Constants ─────────────────────────────────────────────────────────────

    /// @notice Balancer V2 Vault — same address on all EVM networks.
    address public constant VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

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

    // ── Swap step ─────────────────────────────────────────────────────────────

    /// @notice Describes one leg of the arbitrage route.
    /// @dev    `uniV3Fee > 0` → Uniswap V3 exactInputSingle.
    ///         `uniV3Fee == 0` → Aerodrome swapExactTokensForTokens.
    struct SwapStep {
        address dexRouter;    ///< DEX router address for this hop.
        address tokenIn;      ///< Input token for this hop.
        address tokenOut;     ///< Output token for this hop.
        uint24  uniV3Fee;     ///< Pool fee tier (500/3000/10000); 0 = Aerodrome.
        bool    aeroStable;   ///< Aerodrome stable-pool flag (ignored for UniV3).
        address aeroFactory;  ///< Aerodrome pool factory (ignored for UniV3).
        uint256 minAmountOut; ///< Minimum tokens out from this hop (slippage guard).
    }

    // ── Router whitelist ──────────────────────────────────────────────────────

    /// @notice Only whitelisted routers may be called during swap hops.
    mapping(address => bool) public approvedRouters;

    // ── Events ────────────────────────────────────────────────────────────────

    event ArbitrageExecuted(
        address indexed token,
        uint256 amountIn,
        uint256 profit,
        uint256 taxAmount
    );
    event SplitUpdated(address taxWallet, uint256 taxBps);
    event PausedStateChanged(bool paused);
    event MinProfitUpdated(uint256 minProfit);
    event EmergencyWithdraw(address indexed token, uint256 amount, address indexed to);
    event RouterApproved(address indexed router, bool approved);

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

    // ─── Admin — router whitelist ─────────────────────────────────────────────

    /// @notice Approve or revoke a DEX router address.
    ///         Only approved routers may be called in `_swap()`.
    /// @param _router   The DEX router address to configure.
    /// @param _approved True to approve; false to revoke.
    function setRouter(address _router, bool _approved) external onlyOwner {
        require(_router != address(0), "Zero address");
        approvedRouters[_router] = _approved;
        emit RouterApproved(_router, _approved);
    }

    // ─── Admin — min profit ───────────────────────────────────────────────────

    /// @notice Update the minimum net profit threshold.
    /// @param _min  Minimum profit in flash-token base units.
    function setMinProfit(uint256 _min) external onlyOwner {
        minProfitUsdc = _min;
        emit MinProfitUpdated(_min);
    }

    // ─── External entry point ─────────────────────────────────────────────────

    /// @notice Called by the Go bot to initiate a flash-loan-funded arbitrage.
    ///         The entire round-trip (borrow → swap[] → repay → split) is atomic.
    /// @param flashToken   The token to borrow (e.g. USDC on Base).
    /// @param flashAmount  How much to borrow (in token base units).
    /// @param steps        Ordered swap hops; first tokenIn must equal flashToken,
    ///                     last tokenOut must equal flashToken.
    function executeArbitrage(
        address flashToken,
        uint256 flashAmount,
        SwapStep[] calldata steps
    ) external onlyOwner nonReentrant whenNotPaused {
        require(flashToken != address(0), "Zero token");
        require(flashAmount > 0, "Zero amount");
        require(steps.length > 0, "No steps");

        address[] memory tokens  = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0]  = flashToken;
        amounts[0] = flashAmount;

        bytes memory userData = abi.encode(steps, flashAmount, flashToken);
        IBalancerVault(VAULT).flashLoan(address(this), tokens, amounts, userData);
    }

    // ─── Balancer flash loan callback ─────────────────────────────────────────

    /// @notice Called by the Balancer Vault after transferring the flash loan.
    ///         Executes each swap hop, repays the loan, and splits the profit.
    ///         Reverts if profit is below `minProfitUsdc`.
    /// @dev Only callable by the Balancer Vault.  Protected by reentrancy guard
    ///      and pause switch.  Approve-zero-first pattern applied per hop.
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

        (SwapStep[] memory steps, uint256 flashAmount, address flashToken) =
            abi.decode(userData, (SwapStep[], uint256, address));

        require(steps.length > 0, "No steps");

        // ── Execute swap hops ────────────────────────────────────────────────
        uint256 current = amounts[0];
        for (uint256 i = 0; i < steps.length; i++) {
            current = _swap(steps[i], current);
        }

        // ── Balance-based profit calculation ─────────────────────────────────
        // Re-read balance to catch fee-on-transfer tokens and any rounding.
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

    // ─── Internal swap dispatcher ─────────────────────────────────────────────

    /// @dev Executes one hop and returns the amount received.
    ///      Applies approve-zero-first before every allowance grant.
    function _swap(SwapStep memory step, uint256 amountIn) internal returns (uint256) {
        require(step.dexRouter != address(0), "Zero router");
        require(approvedRouters[step.dexRouter], "Router not approved");
        require(step.tokenIn   != address(0), "Zero tokenIn");
        require(step.tokenOut  != address(0), "Zero tokenOut");
        require(amountIn > 0,                 "Zero amountIn");

        // Approve zero first to prevent the ERC-20 approve race condition.
        IERC20(step.tokenIn).approve(step.dexRouter, 0);
        IERC20(step.tokenIn).approve(step.dexRouter, amountIn);

        if (step.uniV3Fee > 0) {
            // ── Uniswap V3 ──────────────────────────────────────────────────
            return IUniswapV3Router(step.dexRouter).exactInputSingle(
                IUniswapV3Router.ExactInputSingleParams({
                    tokenIn:           step.tokenIn,
                    tokenOut:          step.tokenOut,
                    fee:               step.uniV3Fee,
                    recipient:         address(this),
                    amountIn:          amountIn,
                    amountOutMinimum:  step.minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        // ── Aerodrome ────────────────────────────────────────────────────────
        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from:    step.tokenIn,
            to:      step.tokenOut,
            stable:  step.aeroStable,
            factory: step.aeroFactory
        });
        uint256[] memory outs = IAerodromeRouter(step.dexRouter).swapExactTokensForTokens(
            amountIn,
            step.minAmountOut,
            routes,
            address(this),
            block.timestamp + 60
        );
        return outs[outs.length - 1];
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

    /// @dev Accept ETH (e.g. from accidental transfers).
    receive() external payable {}
}
