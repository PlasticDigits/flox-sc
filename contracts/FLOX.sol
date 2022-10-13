// SPDX-License-Identifier: GPL-3.0
// Authored by Plastic Digits & Kevin
// Burns CZUSD, tracks locked liquidity, trades to BNB and sends to Kevin for running green miners
pragma solidity ^0.8.4;
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/presets/ERC20PresetFixedSupply.sol";
import "@openzeppelin/contracts/access/AccessControlEnumerable.sol";
import "@chainlink/contracts/src/v0.8/interfaces/KeeperCompatibleInterface.sol";
import "@openzeppelin/contracts/utils/Checkpoints.sol";
import "./czodiac/CZUSD.sol";
import "./AutoRewardPool_Variable.sol";
import "./libs/AmmLibrary.sol";
import "./interfaces/IAmmFactory.sol";
import "./interfaces/IAmmPair.sol";
import "./interfaces/IAmmRouter02.sol";

contract FLOX is
    ERC20PresetFixedSupply,
    AccessControlEnumerable,
    KeeperCompatibleInterface
{
    using SafeERC20 for IERC20;
    using Address for address payable;
    using Checkpoints for Checkpoints.History;
    bytes32 public constant MANAGER = keccak256("MANAGER");
    AutoRewardPool_Variable public rewardsDistributor;

    Checkpoints.History totalSupplyHistory;

    IERC20 public rewardToken;

    uint256 public burnBPS = 1800;
    uint256 public maxBurnBPS = 3000;
    mapping(address => bool) public isExempt;

    IAmmPair public ammCzusdPair;
    IAmmRouter02 public ammRouter;
    CZUsd public czusd;

    uint256 public baseCzusdLocked;
    uint256 public totalCzusdSpent;
    uint256 public lockedCzusdTriggerLevel = 100 ether;

    bool public tradingOpen;

    address public projectDistributor;
    uint256 public projectBasis = 600;

    address[] public path;

    receive() external payable {}

    constructor(
        CZUsd _czusd,
        IAmmRouter02 _ammRouter,
        IAmmFactory _factory,
        IERC20 _initialRewardToken,
        address _rewardsDistributor,
        uint256 _baseCzusdLocked,
        uint256 _totalSupply,
        address _projectDistributor
    )
        ERC20PresetFixedSupply(
            "FlokiMultiverse",
            "FLOX",
            _totalSupply,
            msg.sender
        )
    {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MANAGER, msg.sender);
        _grantRole(MANAGER, _rewardsDistributor);

        ADMIN_setCzusd(_czusd);
        ADMIN_setAmmRouter(_ammRouter);
        ADMIN_setBaseCzusdLocked(_baseCzusdLocked);

        path[0] = address(czusd);
        path[1] = address(0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56); //BUSD
        path[2] = ammRouter.WETH(); //BNB
        path[3] = address(_initialRewardToken);
        rewardToken = _initialRewardToken;

        MANAGER_setProjectDistributor(_projectDistributor);
        MANAGER_setRewardsDistributor(_rewardsDistributor);

        MANAGER_setIsExempt(msg.sender, true);
        MANAGER_setIsExempt(_rewardsDistributor, true);

        ammCzusdPair = IAmmPair(
            _factory.createPair(address(this), address(czusd))
        );
        totalSupplyHistory.push(totalSupply());
    }

    function lockedCzusd() public view returns (uint256 lockedCzusd_) {
        bool czusdIsToken0 = ammCzusdPair.token0() == address(czusd);
        (uint112 reserve0, uint112 reserve1, ) = ammCzusdPair.getReserves();
        uint256 lockedLP = ammCzusdPair.balanceOf(address(this));
        uint256 totalLP = ammCzusdPair.totalSupply();

        uint256 lockedLpCzusdBal = ((czusdIsToken0 ? reserve0 : reserve1) *
            lockedLP) / totalLP;
        uint256 lockedLpFloxBal = ((czusdIsToken0 ? reserve1 : reserve0) *
            lockedLP) / totalLP;

        if (lockedLpFloxBal == totalSupply()) {
            lockedCzusd_ = lockedLpCzusdBal;
        } else {
            lockedCzusd_ =
                lockedLpCzusdBal -
                (
                    AmmLibrary.getAmountOut(
                        totalSupply() - lockedLpFloxBal,
                        lockedLpFloxBal,
                        lockedLpCzusdBal
                    )
                );
        }
    }

    function availableWadToSend() public view returns (uint256) {
        return lockedCzusd() - baseCzusdLocked - totalCzusdSpent;
    }

    function isOverTriggerLevel() public view returns (bool) {
        return lockedCzusdTriggerLevel <= availableWadToSend();
    }

    function getTotalSupplyAtBlock(uint256 _blockNumber)
        external
        view
        returns (uint256 wad_)
    {
        return totalSupplyHistory.getAtBlock(_blockNumber);
    }

    function checkUpkeep(bytes calldata)
        public
        view
        override
        returns (bool upkeepNeeded, bytes memory)
    {
        upkeepNeeded = isOverTriggerLevel();
    }

    function performUpkeep(bytes calldata) external override {
        uint256 wadToSend = availableWadToSend();
        totalCzusdSpent += wadToSend;
        czusd.mint(address(this), wadToSend);
        czusd.approve(address(ammRouter), wadToSend);

        address[] memory czusdToBnbPath;
        czusdToBnbPath[0] = address(czusd);
        czusdToBnbPath[1] = address(0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56); //BUSD
        czusdToBnbPath[2] = ammRouter.WETH(); //BNB

        ammRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(
            (czusd.balanceOf(address(this)) * projectBasis) / burnBPS,
            0,
            czusdToBnbPath,
            projectDistributor,
            block.timestamp
        );

        uint256 tokensForRewards = rewardToken.balanceOf(address(this));
        //Send to rewards contract
        ammRouter.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            czusd.balanceOf(address(this)),
            0,
            path,
            address(this),
            block.timestamp
        );
        rewardToken.approve(address(rewardsDistributor), tokensForRewards);
        rewardsDistributor.addRewardTokens(tokensForRewards);
    }

    function _burn(address _sender, uint256 _burnAmount) internal override {
        super._burn(_sender, _burnAmount);
        totalSupplyHistory.push(totalSupply());
    }

    function _transfer(
        address sender,
        address recipient,
        uint256 amount
    ) internal override {
        require(sender != address(0), "ERC20: transfer from the zero address");
        require(recipient != address(0), "ERC20: transfer to the zero address");

        //Handle burn
        if (
            //No tax for exempt
            isExempt[sender] ||
            isExempt[recipient] ||
            //No tax if not a trade
            (sender != address(ammCzusdPair) &&
                recipient != address(ammCzusdPair))
        ) {
            super._transfer(sender, recipient, amount);
            rewardsDistributor.deposit(recipient, amount);
            rewardsDistributor.withdraw(sender, amount);
        } else {
            require(tradingOpen, "FLOX: Not open");
            uint256 burnAmount = (amount * burnBPS) / 10000;
            if (burnAmount > 0) _burn(sender, burnAmount);
            uint256 postBurnAmount = amount - burnAmount;
            super._transfer(sender, recipient, postBurnAmount);
            rewardsDistributor.deposit(recipient, postBurnAmount);
            rewardsDistributor.withdraw(sender, amount);
        }
    }

    function MANAGER_setIsExempt(address _for, bool _to)
        public
        onlyRole(MANAGER)
    {
        isExempt[_for] = _to;
    }

    function MANAGER_setBps(uint256 _toBps) public onlyRole(MANAGER) {
        require(_toBps <= maxBurnBPS, "FLOX: Burn too high");
        burnBPS = _toBps;
    }

    function MANAGER_setRewardsDistributor(address _to)
        public
        onlyRole(MANAGER)
    {
        rewardsDistributor = AutoRewardPool_Variable(_to);
    }

    function MANAGER_setProjectDistributor(address _to)
        public
        onlyRole(MANAGER)
    {
        projectDistributor = _to;
    }

    //If the token is XXX and is paired against BNB, then _rewardToken should be the token and _basePairToken should be the WBNB address `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`
    //NOTE: THe base pair token must have decent liquidity against BUSD on pancakeswap (Ex: BNB/BUSD is fine). Otherwise the admin will need to update the path.
    function MANAGER_setRewardToken(
        address _rewardToken,
        address _basePairToken
    ) public onlyRole(MANAGER) {
        rewardToken = IERC20(_rewardToken);
        rewardsDistributor.updateRewardToken(IERC20(_rewardToken));
        path[path.length - 2] = address(_basePairToken);
        path[path.length - 1] = address(_rewardToken);
    }

    function ADMIN_setPath(address[] calldata _path)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        delete path;
        path = _path;
    }

    function ADMIN_openTrading() external onlyRole(DEFAULT_ADMIN_ROLE) {
        tradingOpen = true;
    }

    function ADMIN_recoverERC20(address tokenAddress)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        IERC20(tokenAddress).transfer(
            _msgSender(),
            IERC20(tokenAddress).balanceOf(address(this))
        );
    }

    function ADMIN_withdraw(address payable _to)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _to.sendValue(address(this).balance);
    }

    function ADMIN_setBaseCzusdLocked(uint256 _to)
        public
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        baseCzusdLocked = _to;
    }

    function ADMIN_setProjectBasis(uint256 _to)
        public
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        projectBasis = _to;
    }

    function ADMIN_setLockedCzusdTriggerLevel(uint256 _to)
        public
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        lockedCzusdTriggerLevel = _to;
    }

    function ADMIN_setAmmRouter(IAmmRouter02 _to)
        public
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        ammRouter = _to;
    }

    function ADMIN_setCzusd(CZUsd _to) public onlyRole(DEFAULT_ADMIN_ROLE) {
        czusd = _to;
    }

    function ADMIN_setMaxBurnBps(uint256 _to)
        public
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        maxBurnBPS = _to;
    }
}
