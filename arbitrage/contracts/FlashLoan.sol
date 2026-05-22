// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// filepath: contracts/FlashLoan.sol
// Deploy to Base mainnet. Uses Balancer V2 flash loans (0% fee).
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

contract ApexFlashLoan {
    // Balancer V2 Vault — same address on all networks
    address public constant VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    address public immutable owner;

    // ─── Profit split ────────────────────────────────────────────────────────
    address public taxWallet;
    uint256 public taxBps;  // e.g. 3000 = 30%, max 5000

    struct SwapStep {
        address dexRouter;
        address tokenIn;
        address tokenOut;
        uint24  uniV3Fee;     // > 0 = Uniswap V3; 0 = Aerodrome
        bool    aeroStable;
        address aeroFactory;
        uint256 minAmountOut;
    }

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
    /// @param _taxBps     Basis points (3000 = 30%, max 5000).
    function setSplit(address _taxWallet, uint256 _taxBps) external onlyOwner {
        require(_taxWallet != address(0), "Zero address");
        require(_taxBps <= 5000, "Max 50%");
        taxWallet = _taxWallet;
        taxBps    = _taxBps;
        emit SplitUpdated(_taxWallet, _taxBps);
    }

    // ─── External entry point ────────────────────────────────────────────────

    /// @notice Called by the Go bot to initiate a flash-loan-funded arbitrage.
    /// @param flashToken  The token to borrow (e.g. USDC).
    /// @param flashAmount How much to borrow.
    /// @param steps       The 3-hop swap path encoded as SwapStep[].
    function executeArbitrage(
        address flashToken,
        uint256 flashAmount,
        SwapStep[] calldata steps
    ) external onlyOwner {
        address[] memory tokens  = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0]  = flashToken;
        amounts[0] = flashAmount;

        bytes memory userData = abi.encode(steps, flashAmount, flashToken);
        IBalancerVault(VAULT).flashLoan(address(this), tokens, amounts, userData);
    }

    // ─── Balancer flash loan callback ────────────────────────────────────────

    function receiveFlashLoan(
        address[] memory,
        uint256[] memory amounts,
        uint256[] memory,
        bytes memory userData
    ) external {
        require(msg.sender == VAULT, "Only Balancer Vault");

        (SwapStep[] memory steps, uint256 flashAmount, address flashToken) =
            abi.decode(userData, (SwapStep[], uint256, address));

        uint256 current = amounts[0];
        for (uint256 i = 0; i < steps.length; i++) {
            current = _swap(steps[i], current);
        }

        // Repay exactly what was borrowed (Balancer fee = 0)
        require(
            IERC20(flashToken).transfer(VAULT, flashAmount),
            "Repay failed"
        );

        uint256 profit = current > flashAmount ? current - flashAmount : 0;
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

    // ─── Internal swap dispatcher ─────────────────────────────────────────────

    function _swap(SwapStep memory step, uint256 amountIn) internal returns (uint256) {
        IERC20(step.tokenIn).approve(step.dexRouter, amountIn);

        if (step.uniV3Fee > 0) {
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

        // Aerodrome
        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from:    step.tokenIn,
            to:      step.tokenOut,
            stable:  step.aeroStable,
            factory: step.aeroFactory
        });
        uint256[] memory outs = IAerodromeRouter(step.dexRouter).swapExactTokensForTokens(
            amountIn, step.minAmountOut, routes, address(this), block.timestamp + 60
        );
        return outs[outs.length - 1];
    }

    // ─── Owner utilities ─────────────────────────────────────────────────────

    function withdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "Nothing to withdraw");
        IERC20(token).transfer(owner, bal);
    }

    receive() external payable {}
}
