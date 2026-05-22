// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Deploy to Base (or Arbitrum). Uses Balancer V2 flash loans (0% fee).
// Executes an arbitrary Uniswap V3 exactInput multi-hop path with borrowed funds.
// Path must start and end with the same token (flashToken) so the loan can be repaid.
// Profit is automatically split: taxBps% → taxWallet, remainder → owner.

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

contract ApexFlashLoan {
    // Balancer V2 Vault — same address on all networks
    address public constant VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    address public immutable owner;

    // ─── Profit split ────────────────────────────────────────────────────────
    // taxWallet receives taxBps/10000 of every profit automatically.
    // Set once after deployment via setSplit(). Max 50% enforced.
    address public taxWallet;
    uint256 public taxBps;  // e.g. 3000 = 30%

    event ArbitrageExecuted(address indexed token, uint256 amountIn, uint256 profit, uint256 taxAmount);
    event SplitUpdated(address taxWallet, uint256 taxBps);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ─── Configure profit split ───────────────────────────────────────────────

    /// @notice Set the tax wallet and percentage. Call once after deployment.
    /// @param _taxWallet  Address that receives the tax portion of every profit.
    /// @param _taxBps     Basis points to send to taxWallet (3000 = 30%, max 5000).
    function setSplit(address _taxWallet, uint256 _taxBps) external onlyOwner {
        require(_taxWallet != address(0), "Zero address");
        require(_taxBps <= 5000, "Max 50%");
        taxWallet = _taxWallet;
        taxBps    = _taxBps;
        emit SplitUpdated(_taxWallet, _taxBps);
    }

    // ─── External entry point ────────────────────────────────────────────────

    /// @notice Initiate a Balancer V2 flash loan and execute a UniV3 multi-hop arb.
    /// @param flashToken    Token to borrow (e.g. USDC).
    /// @param flashAmount   Amount to borrow.
    /// @param uniV3Router   Uniswap V3 SwapRouter02 address.
    /// @param path          ABI-packed multi-hop path: addr|fee|addr|fee|...|addr.
    ///                      Must start AND end with flashToken.
    /// @param minAmountOut  Minimum tokens back from the swap (sandwich protection).
    function executeArbitrage(
        address flashToken,
        uint256 flashAmount,
        address uniV3Router,
        bytes calldata path,
        uint256 minAmountOut
    ) external onlyOwner {
        address[] memory tokens  = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0]  = flashToken;
        amounts[0] = flashAmount;

        bytes memory userData = abi.encode(
            uniV3Router, path, flashAmount, flashToken, minAmountOut
        );
        IBalancerVault(VAULT).flashLoan(address(this), tokens, amounts, userData);
    }

    // ─── Balancer flash loan callback ────────────────────────────────────────

    /// @notice Called by Balancer after transferring the flash loan.
    ///         Executes the multi-hop swap, repays loan, splits profit automatically.
    function receiveFlashLoan(
        address[] memory,
        uint256[] memory amounts,
        uint256[] memory,          // feeAmounts — always 0 on Balancer V2
        bytes memory userData
    ) external {
        require(msg.sender == VAULT, "Only Balancer Vault");

        (
            address uniV3Router,
            bytes memory path,
            uint256 flashAmount,
            address flashToken,
            uint256 minAmountOut
        ) = abi.decode(userData, (address, bytes, uint256, address, uint256));

        IERC20(flashToken).approve(uniV3Router, amounts[0]);

        uint256 amountOut = IUniswapV3Router(uniV3Router).exactInput(
            IUniswapV3Router.ExactInputParams({
                path:             path,
                recipient:        address(this),
                amountIn:         amounts[0],
                amountOutMinimum: minAmountOut
            })
        );

        // Repay exactly what was borrowed (Balancer fee = 0)
        require(
            IERC20(flashToken).transfer(VAULT, flashAmount),
            "Repay failed"
        );

        uint256 profit = amountOut > flashAmount ? amountOut - flashAmount : 0;
        require(profit > 0, "No profit");

        // ── Auto profit split ────────────────────────────────────────────────
        uint256 taxAmount = 0;
        if (taxWallet != address(0) && taxBps > 0) {
            taxAmount = (profit * taxBps) / 10_000;
            if (taxAmount > 0) {
                IERC20(flashToken).transfer(taxWallet, taxAmount);
            }
        }

        IERC20(flashToken).transfer(owner, profit - taxAmount);
        emit ArbitrageExecuted(flashToken, flashAmount, profit, taxAmount);
    }

    // ─── Owner utilities ─────────────────────────────────────────────────────

    /// @notice Rescue any ERC-20 token stuck in this contract.
    function withdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "Nothing to withdraw");
        IERC20(token).transfer(owner, bal);
    }

    receive() external payable {}
}
