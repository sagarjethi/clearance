// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {StateView} from "@uniswap/v4-periphery/src/lens/StateView.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {ClearanceAccount} from "../src/ClearanceAccount.sol";
import {ClearanceHook} from "../src/ClearanceHook.sol";
import {ClearanceRouter} from "../src/ClearanceRouter.sol";
import {VerifierSet} from "../src/VerifierSet.sol";
import {LocalTextResolver} from "../src/test-support/LocalTextResolver.sol";
import {PlainToken, RugToken} from "../src/test-support/TestTokens.sol";
import {TestUSDC} from "../src/test-support/TestUSDC.sol";

/// @notice Deploys the system and test pools. Unset addresses are deployed fresh, which is local mode.
/// On Sepolia, set POOL_MANAGER, QUOTER, STATE_VIEW and USDC to the real contracts.
contract Deploy is Script {
    address private constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    int24 private constant TICK_SPACING = 60;
    int24 private constant RANGE = 12_000;
    uint24 private constant FEE = 3000;
    uint256 private constant SUPPLY = 1e12 * 1e18;

    PoolModifyLiquidityTest private liquidity;
    IPoolManager private manager;
    IERC20 private usdc;
    string private json;

    function run() external {
        uint256 ownerPk = vm.envUint("OWNER_KEY");
        address owner = vm.addr(ownerPk);
        address agentKey = vm.envAddress("AGENT_KEY_ADDRESS");
        address[] memory verifierList = vm.envAddress("VERIFIER_ADDRESSES", ",");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        string memory agentName = vm.envOr("AGENT_NAME", string("alice.agents.clearance.eth"));
        string memory out = vm.envOr("DEPLOYMENT_FILE", string("../deployments/local.json"));

        vm.startBroadcast(ownerPk);

        address managerAddress = vm.envOr("POOL_MANAGER", address(0));
        manager = managerAddress == address(0) ? IPoolManager(address(new PoolManager(owner))) : IPoolManager(managerAddress);
        address quoterAddress = vm.envOr("QUOTER", address(0));
        if (quoterAddress == address(0)) quoterAddress = address(new V4Quoter(manager));
        address stateViewAddress = vm.envOr("STATE_VIEW", address(0));
        if (stateViewAddress == address(0)) stateViewAddress = address(new StateView(manager));
        address usdcAddress = vm.envOr("USDC", address(0));
        if (usdcAddress == address(0)) usdcAddress = address(new TestUSDC(owner, 1e12 * 1e6));
        usdc = IERC20(usdcAddress);

        VerifierSet verifiers = new VerifierSet(owner, verifierList, 2);
        ClearanceRouter router = new ClearanceRouter(manager);

        bytes memory args = abi.encode(manager, verifiers, owner);
        (, bytes32 salt) = HookMiner.find(
            CREATE2_DEPLOYER, uint160(Hooks.BEFORE_SWAP_FLAG), type(ClearanceHook).creationCode, args
        );
        ClearanceHook hook = new ClearanceHook{salt: salt}(manager, verifiers, owner);
        hook.setRouter(address(router), true);
        hook.setQuoter(quoterAddress, true);

        ClearanceAccount account = new ClearanceAccount(owner, agentKey, verifiers, router, address(hook));

        PlainToken weth = new PlainToken("Test Wrapped Ether", "tWETH", owner, SUPPLY);
        PlainToken moon = new PlainToken("Thin Moon", "tMOON", owner, SUPPLY);
        RugToken rug = new RugToken(owner, SUPPLY);

        liquidity = new PoolModifyLiquidityTest(manager);
        usdc.approve(address(liquidity), type(uint256).max);

        json = "{}";
        vm.serializeUint("d", "chainId", block.chainid);
        vm.serializeAddress("d", "owner", owner);
        vm.serializeAddress("d", "agentKey", agentKey);
        vm.serializeAddress("d", "treasury", treasury);
        vm.serializeAddress("d", "poolManager", address(manager));
        vm.serializeAddress("d", "quoter", quoterAddress);
        vm.serializeAddress("d", "stateView", stateViewAddress);
        vm.serializeAddress("d", "usdc", usdcAddress);
        vm.serializeAddress("d", "verifierSet", address(verifiers));
        vm.serializeAddress("d", "router", address(router));
        vm.serializeAddress("d", "hook", address(hook));
        vm.serializeAddress("d", "account", address(account));
        vm.serializeAddress("d", "weth", address(weth));
        vm.serializeAddress("d", "moon", address(moon));
        vm.serializeAddress("d", "rug", address(rug));

        _pool("wethPool", address(weth), 3000, 5_000_000, address(hook));
        _pool("moonPool", address(moon), 1, 5_000, address(hook));
        _pool("rugPool", address(rug), 1, 500_000, address(hook));
        _pool("outsideRugPool", address(rug), 1, 500_000, address(0));

        address resolverAddress = vm.envOr("RESOLVER", address(0));
        if (resolverAddress == address(0)) {
            LocalTextResolver resolver = new LocalTextResolver(owner);
            resolverAddress = address(resolver);
            bytes32 node = vm.ensNamehash(agentName);
            resolver.setText(node, "clearance.maxSizeUsd", "1000");
            resolver.setText(node, "clearance.humanCapUsd", "25000");
            resolver.setText(node, "clearance.maxImpactBps", "300");
            resolver.setText(node, "clearance.requiredVerifiers", "2");
            resolver.setText(node, "clearance.maxPaymentUsd", "1");
            resolver.setText(node, "clearance.allowedPayees", vm.toString(treasury));
            resolver.setText(node, "clearance.ownerSub", vm.envOr("OWNER_SUB", string("local-owner")));
            resolver.setText(
                node,
                "clearance.allowedTokens",
                string.concat(vm.toString(usdcAddress), ",", vm.toString(address(weth)), ",", vm.toString(address(moon)))
            );
            for (uint256 i; i < verifierList.length; i++) {
                resolver.grantKey(verifierList[i], "clearance.score");
            }
        }

        // The USDC transfer needs the owner's balance, so this reverts on Sepolia if the wallet isn't funded.
        usdc.transfer(address(account), vm.envOr("ACCOUNT_USDC", uint256(100_000e6)));

        vm.stopBroadcast();

        vm.serializeAddress("d", "resolver", resolverAddress);
        string memory finalJson = vm.serializeString("d", "agentName", agentName);
        vm.writeJson(finalJson, out);
    }

    /// @dev Creates a USDC pair at `priceUsd` per whole token, with about `usdDepth` of USDC on the USDC side.
    function _pool(string memory label, address token, uint256 priceUsd, uint256 usdDepth, address hook) private {
        IERC20(token).approve(address(liquidity), type(uint256).max);

        bool usdcIsZero = address(usdc) < token;
        (address token0, address token1) = usdcIsZero ? (address(usdc), token) : (token, address(usdc));
        // Raw price is token1 per token0. Test tokens have 18 decimals and USDC has 6.
        uint256 priceX192 = usdcIsZero
            ? Math.mulDiv(1e12, 1 << 192, priceUsd)
            : Math.mulDiv(priceUsd, 1 << 192, 1e12);
        uint160 sqrtPrice = uint160(Math.sqrt(priceX192));

        PoolKey memory key = PoolKey(Currency.wrap(token0), Currency.wrap(token1), FEE, TICK_SPACING, IHooks(hook));
        manager.initialize(key, sqrtPrice);

        int24 tick = TickMath.getTickAtSqrtPrice(sqrtPrice);
        tick = (tick / TICK_SPACING) * TICK_SPACING;
        int24 lower = tick - RANGE;
        int24 upper = tick + RANGE;
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(lower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(upper);
        uint256 usdcAmount = usdDepth * 1e6;
        uint128 liq = usdcIsZero
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtPrice, sqrtUpper, usdcAmount)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtPrice, usdcAmount);
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, int256(uint256(liq)), 0), "");

        string memory obj = string.concat(label, "Obj");
        vm.serializeAddress(obj, "currency0", token0);
        vm.serializeAddress(obj, "currency1", token1);
        vm.serializeUint(obj, "fee", FEE);
        vm.serializeInt(obj, "tickSpacing", TICK_SPACING);
        string memory poolJson = vm.serializeAddress(obj, "hooks", hook);
        vm.serializeString("d", label, poolJson);
    }
}
