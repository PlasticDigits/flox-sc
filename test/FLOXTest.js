// SPDX-License-Identifier: GPL-3.0
// Authored by Plastic Digits
// If you read this, know that I love you even if your mom doesnt <3
const chai = require('chai');
const {
  time, impersonateAccount, mine
} = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { expect } = require("chai");
const { parseEther, formatEther, defaultAbiCoder } = ethers.utils;
const { toNum, toBN } = require("./utils/bignumberConverter");
const parse = require('csv-parse');

const BASE_CZUSD_LP_WAD = parseEther("42500");
const INITIAL_CZUSD_LP_WAD = parseEther("42500");
const INITIAL_SUPPLY = parseEther("1000000000");
const CZUSD_TOKEN = "0xE68b79e51bf826534Ff37AA9CeE71a3842ee9c70";
const WBNB_TOKEN = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const BUSD_TOKEN = "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56";
const DOGECOIN_TOKEN = "0xbA2aE424d960c26247Dd6c32edC70B295c744C43"; //used for testing rewards
const PCS_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const PCS_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const DEPLOYER = "0x70e1cB759996a1527eD1801B169621C18a9f38F9";


describe("FLOX", function () {
  let owner, manager, trader, trader1, trader2, trader3, feeDistributor;
  let deployer;
  let flox, czusd, busd, dogeCoin, pcsRouter, floxCzusdPair, autoRewardPool;
  before(async function() {
    [owner, manager, trader, trader1, trader2, trader3, feeDistributor] = await ethers.getSigners();
    await impersonateAccount(DEPLOYER);
    deployer = await ethers.getSigner(DEPLOYER);

    pcsRouter = await ethers.getContractAt("IAmmRouter02", PCS_ROUTER);
    czusd = await ethers.getContractAt("CZUsd", CZUSD_TOKEN);
    dogeCoin = await ethers.getContractAt("IERC20", DOGECOIN_TOKEN);
    busd = await ethers.getContractAt("IERC20", BUSD_TOKEN);

    console.log("deploying autorewardpool")

    const AutoRewardPool = await ethers.getContractFactory("AutoRewardPool_Variable");
    autoRewardPool = await AutoRewardPool.deploy();

    console.log("deploying Flox")
    const Flox = await ethers.getContractFactory("FLOX");
    flox = await Flox.deploy(
      CZUSD_TOKEN,
      PCS_ROUTER,
      PCS_FACTORY,
      autoRewardPool.address,
      BASE_CZUSD_LP_WAD,
      INITIAL_SUPPLY,
      manager.address
    );
    
    console.log("getting ammCzusdPair")
    const floxCzusdPair_address = await flox.ammCzusdPair();
    floxCzusdPair = await ethers.getContractAt("IAmmPair", floxCzusdPair_address);

    console.log("initialize autoRewardPool")
    await autoRewardPool.initialize(flox.address,floxCzusdPair.address);

    console.log("Set reward token")
    await flox.connect(manager).MANAGER_setRewardToken(
      dogeCoin.address,//address _rewardToken,
      WBNB_TOKEN//address _basePairToken
    );
    
    await czusd
    .connect(deployer)
    .grantRole(ethers.utils.id("MINTER_ROLE"), flox.address);

    await czusd.connect(deployer).mint(owner.address,INITIAL_CZUSD_LP_WAD);
    await flox.approve(pcsRouter.address,ethers.constants.MaxUint256);
    await czusd.approve(pcsRouter.address,ethers.constants.MaxUint256);
    console.log("add liq")
    await pcsRouter.addLiquidity(
      czusd.address,
      flox.address,
      INITIAL_CZUSD_LP_WAD,
      INITIAL_SUPPLY, //100% to liquidity
      0,
      0,
      flox.address,
      ethers.constants.MaxUint256
    );
  });
  it("Should deploy flox", async function () {
    const pairCzusdBal = await czusd.balanceOf(floxCzusdPair.address);
    const pairFloxBal = await flox.balanceOf(floxCzusdPair.address);
    const baseCzusdLocked = await flox.baseCzusdLocked();
    const totalCzusdSpent = await flox.totalCzusdSpent();
    const ownerIsExempt = await flox.isExempt(owner.address);
    const pairIsExempt = await flox.isExempt(floxCzusdPair.address);
    const tradingOpen = await flox.tradingOpen();
    expect(pairCzusdBal).to.eq(INITIAL_CZUSD_LP_WAD);
    expect(pairFloxBal).to.eq(INITIAL_SUPPLY);
    expect(baseCzusdLocked).to.eq(BASE_CZUSD_LP_WAD);
    expect(totalCzusdSpent).to.eq(0);
    expect(ownerIsExempt).to.be.true;
    expect(pairIsExempt).to.be.false;
    expect(tradingOpen).to.be.false;
  });
  it("Should revert buy when trading not open", async function () {
    await czusd.connect(deployer).mint(trader.address,parseEther("10000"));
    await czusd.connect(trader).approve(pcsRouter.address,ethers.constants.MaxUint256);
    
    await expect(pcsRouter.connect(trader).swapExactTokensForTokensSupportingFeeOnTransferTokens(
        parseEther("100"),
        0,
        [czusd.address,flox.address],
        trader.address,
        ethers.constants.MaxUint256
    )).to.be.reverted;
  });
  it("Should burn 18% when buying and increase wad available", async function () {    
    await flox.ADMIN_openTrading();
    const totalStakedInitial = await autoRewardPool.totalStaked();
    const traderBalInitial = await flox.balanceOf(trader.address);
    console.log("Attempting swap...")
    await pcsRouter.connect(trader).swapExactTokensForTokensSupportingFeeOnTransferTokens(
        parseEther("100"),
        0,
        [czusd.address,flox.address],
        trader.address,
        ethers.constants.MaxUint256
    );
    console.log("Swap success.")
    const pendingReward = await autoRewardPool.pendingReward(1, trader.address);
    const {accTokenPerShare_,
      rewardPerSecond_,
      globalRewardDebt_,
      timestampLast_,
      timestampEnd_,
      totalStakedFinal_,
      totalRewardsPaid_,
      totalRewardsAdded_,
      rewardToken_} = await autoRewardPool.getPool(1);    
    const totalCzusdSpent = await flox.totalCzusdSpent();
    const lockedCzusd = await flox.lockedCzusd();
    const availableWadToSend = await flox.availableWadToSend();
    const totalSupply = await flox.totalSupply();
    const traderBalFinal = await flox.balanceOf(trader.address);
    console.log(formatEther(lockedCzusd));
    console.log(formatEther(totalSupply));
    expect(pendingReward).to.eq(0);
    expect(totalStakedFinal_.sub(totalStakedInitial)).to.eq(traderBalFinal.sub(traderBalInitial));
    expect(totalStakedInitial).to.eq(0);
    expect(rewardPerSecond_).to.eq(0);
    expect(totalCzusdSpent).to.eq(0);
    expect(lockedCzusd).to.be.closeTo(parseEther("42518.3"),parseEther("0.1"));
    expect(availableWadToSend).to.eq(lockedCzusd.sub(BASE_CZUSD_LP_WAD).sub(totalCzusdSpent));
    expect(totalSupply).to.be.closeTo(parseEther("999578518"),parseEther("1"));
  });
  /*it("Should send reward to dev wallet", async function() {
    const devWalletBalInitial = await dogeCoin.balanceOf(manager.address);
    const autoRewardPoolBalInitial = await dogeCoin.balanceOf(autoRewardPool.address);
    const availableWadToSendInitial = await flox.availableWadToSend();
    await flox.performUpkeep(0);
    const devWalletBalFinal = await dogeCoin.balanceOf(manager.address);
    const autoRewardPoolBalFinal = await dogeCoin.balanceOf(autoRewardPool.address);
    const availableWadToSendFinal = await flox.availableWadToSend();
    const totalCzusdSpent = await flox.totalCzusdSpent();
    const traderBal = await flox.balanceOf(trader.address);
    await flox.connect(trader).transfer(trader1.address,traderBal);
    const trader1Bal = await flox.balanceOf(trader1.address);
    await flox.connect(trader1).transfer(trader.address,trader1Bal);
    const rewardPerSecond = await autoRewardPool.rewardPerSecond();

    expect(totalCzusdSpent).to.eq(availableWadToSendInitial);
    expect(totalCzusdSpent).to.be.closeTo(parseEther("35.4"),parseEther("0.1"));
    expect(availableWadToSendFinal).to.eq(0);
    //dogecoin has 8 decimals, divide 18 decimals by 10*10 to get 8.
    expect(devWalletBalFinal.sub(devWalletBalInitial)).closeTo(parseEther("90").div(10**10),parseEther("1").div(10**10));
    expect(autoRewardPoolBalFinal.sub(autoRewardPoolBalInitial)).closeTo(parseEther("452").div(10**10),parseEther("1").div(10**10));
    expect(autoRewardPoolBalFinal.sub(autoRewardPoolBalInitial).div(86400*7)).to.be.eq(rewardPerSecond);
    expect(rewardPerSecond).to.eq(74810);

  });
  it("Should properly set rps on second update", async function() {
    await time.increase(1*86400);
    await mine(1);
    const autoRewardPoolBalInitial = await dogeCoin.balanceOf(autoRewardPool.address);
    await flox.performUpkeep(0);
    await time.increase(10);
    await mine(1);
    const autoRewardPoolBalFinal = await dogeCoin.balanceOf(autoRewardPool.address);
    const traderBal = await flox.balanceOf(trader.address);
    await flox.connect(trader).transfer(trader1.address,traderBal);
    const trader1Bal = await flox.balanceOf(trader1.address);
    await flox.connect(trader1).transfer(trader.address,trader1Bal);
    const rewardPerSecond = await autoRewardPool.rewardPerSecond();
    const totalRewardsPaid = await autoRewardPool.totalRewardsPaid();
    const traderRewardsReceived = await autoRewardPool.totalRewardsReceived(trader.address);
    const traderRewardBal = await dogeCoin.balanceOf(trader.address);
    const trader1RewardsReceived = await autoRewardPool.totalRewardsReceived(trader1.address);
    const trader1RewardBal = await dogeCoin.balanceOf(trader1.address);
    const autoRewardPoolBalPostRewards = await dogeCoin.balanceOf(autoRewardPool.address);
    const timestampEnd = await autoRewardPool.timestampEnd();
    const currentTime = await time.latest();
    const traderPending = await autoRewardPool.pendingReward(trader.address);
    const trader1Pending = await autoRewardPool.pendingReward(trader1.address);
    expect(traderPending).to.eq(0);
    expect(trader1Pending).to.eq(0);
    expect(traderRewardBal).closeTo(parseEther("64").div(10**10),parseEther("1").div(10**10));
    expect(trader1RewardBal).to.eq(164665)
    expect(traderRewardsReceived).to.eq(traderRewardBal);
    expect(trader1RewardsReceived).to.eq(trader1RewardBal);
    expect(totalRewardsPaid).to.eq(traderRewardBal.add(trader1RewardBal))
    expect(autoRewardPoolBalFinal.sub(autoRewardPoolBalInitial)).closeTo(parseEther("159").div(10**10),parseEther("1").div(10**10));
    expect(rewardPerSecond).to.eq(90547);
    expect(rewardPerSecond.mul(timestampEnd.sub(currentTime))).closeTo(autoRewardPoolBalPostRewards,10000000);
  });
  it("Should properly set pending rewards with third trader and third update", async function() {
    await czusd.connect(deployer).mint(trader2.address,parseEther("10000"));
    await czusd.connect(trader2).approve(pcsRouter.address,ethers.constants.MaxUint256);
    await pcsRouter.connect(trader2).swapExactTokensForTokensSupportingFeeOnTransferTokens(
        parseEther("100"),
        0,
        [czusd.address,flox.address],
        trader2.address,
        ethers.constants.MaxUint256
    );
    const currentTimeInitial = await time.latest();
    await time.increase(1*86400);
    await mine(1);
    const currentTimeMiddle = await time.latest();
    const autoRewardPoolBalInitial = await dogeCoin.balanceOf(autoRewardPool.address);
    await flox.performUpkeep(0);
    const autoRewardPoolBalFinal = await dogeCoin.balanceOf(autoRewardPool.address);
    const traderBal = await flox.balanceOf(trader.address);
    await flox.connect(trader).transfer(trader1.address,traderBal);
    const trader1Bal = await flox.balanceOf(trader1.address);
    await flox.connect(trader1).transfer(trader.address,trader1Bal);
    const rewardPerSecond = await autoRewardPool.rewardPerSecond();
    const totalRewardsPaid = await autoRewardPool.totalRewardsPaid();
    const autoRewardPoolBalPostRewards = await dogeCoin.balanceOf(autoRewardPool.address);
    const currentTimeFinal = await time.latest();
    const timestampEnd = await autoRewardPool.timestampEnd();
    const traderPending = await autoRewardPool.pendingReward(trader.address);
    const trader1Pending = await autoRewardPool.pendingReward(trader1.address);
    const trader2Pending = await autoRewardPool.pendingReward(trader2.address);

    expect(rewardPerSecond).to.eq(114076);
    expect(traderPending).to.eq(0);
    expect(trader1Pending).to.eq(0);
    expect(trader2Pending).closeTo(parseEther("51").div(10**10),parseEther("1").div(10**10));
    expect(rewardPerSecond.mul(timestampEnd.sub(currentTimeFinal))).closeTo(autoRewardPoolBalPostRewards.sub(trader2Pending),10000000);
  });
  it("DggLock: should deploy", async function() {
    
    const dggLockDGGAddress = await dggLock.DGG();
    const dggLockautoRewardPoolAddress = await dggLock.autoRewardPool();
    expect(dggLockDGGAddress).to.eq(flox.address);
    expect(dggLockautoRewardPoolAddress).to.eq(autoRewardPool.address);
  });
  it("DggLock: should accept vestors", async function() {
    const currentTime = await time.latest();
    await dggLock.setVestSchedule(currentTime+86400*7,currentTime+86400*8);
    await flox.approve(dggLock.address,ethers.constants.MaxUint256);
    await dggLock.addVestings([vestor1.address,vestor2.address],[parseEther("500000000"),parseEther("1000000000")]);

    const vestor1DggInitial = await dggLock.accountDggInitial(vestor1.address);
    const vestor2DggInitial = await dggLock.accountDggInitial(vestor2.address);
    const vestor1DggClaimable = await dggLock.accountDggClaimable(vestor1.address);
    const vestor2DggClaimable = await dggLock.accountDggClaimable(vestor2.address);
    const vestor1DogeClaimable = await autoRewardPool.pendingReward(vestor1.address);
    const vestor2DogeClaimable = await autoRewardPool.pendingReward(vestor2.address);
    const firstUnlockEpoch = await dggLock.firstUnlockEpoch();
    const secondUnlockEpoch = await dggLock.secondUnlockEpoch();
    const lockBal = await flox.balanceOf(dggLock.address);

    expect(vestor1DggClaimable).to.eq(parseEther("100000000"));
    expect(vestor2DggClaimable).to.eq(parseEther("200000000"));
    expect(vestor1DogeClaimable).to.eq(0);
    expect(vestor2DogeClaimable).to.eq(0);
    expect(vestor1DggInitial).to.eq(parseEther("500000000"));
    expect(vestor2DggInitial).to.eq(parseEther("1000000000"));
    expect(lockBal).to.eq(parseEther("1500000000"));
    expect(firstUnlockEpoch).to.eq(currentTime+86400*7);
    expect(secondUnlockEpoch).to.eq(currentTime+86400*8);
  });
  it("DggLock: Should properly set pending rewards for dggLock", async function() {
    await czusd.connect(deployer).mint(trader2.address,parseEther("10000"));
    await czusd.connect(trader2).approve(pcsRouter.address,ethers.constants.MaxUint256);
    await pcsRouter.connect(trader2).swapExactTokensForTokensSupportingFeeOnTransferTokens(
        parseEther("10"),
        0,
        [czusd.address,flox.address],
        trader2.address,
        ethers.constants.MaxUint256
    );
    await time.increase(5*86400);
    await mine(1);
    await flox.performUpkeep(0);
    const traderBal = await flox.balanceOf(trader.address);
    await flox.connect(trader).transfer(trader1.address,traderBal);
    const trader1Bal = await flox.balanceOf(trader1.address);
    await flox.connect(trader1).transfer(trader.address,trader1Bal);
    const rewardPerSecond = await autoRewardPool.rewardPerSecond();
    const autoRewardPoolBalPostRewards = await dogeCoin.balanceOf(autoRewardPool.address);
    const currentTimeFinal = await time.latest();
    const timestampEnd = await autoRewardPool.timestampEnd();
    const traderPending = await autoRewardPool.pendingReward(trader.address);
    const trader1Pending = await autoRewardPool.pendingReward(trader1.address);
    const trader2Pending = await autoRewardPool.pendingReward(trader2.address);
    const vestor1LockPending = await autoRewardPool.pendingReward(vestor1.address);
    const vestor2LockPending = await autoRewardPool.pendingReward(vestor2.address);
    expect(rewardPerSecond).to.eq(48126);
    expect(traderPending).to.eq(0);
    expect(trader1Pending).to.eq(0);
    expect(trader2Pending).closeTo(parseEther("3.2").div(10**10),parseEther("0.1").div(10**10));
    expect(vestor1LockPending).closeTo(parseEther("162").div(10**10),parseEther("1").div(10**10));
    expect(vestor2LockPending).closeTo(parseEther("325").div(10**10),parseEther("1").div(10**10));
    expect(rewardPerSecond.mul(timestampEnd.sub(currentTimeFinal))).closeTo(autoRewardPoolBalPostRewards.sub(trader2Pending).sub(vestor2LockPending).sub(vestor1LockPending),10000000);
  });
  it("DggLock: Should claim rewards for vestor", async function() {

    const rewardPerSecond = await autoRewardPool.rewardPerSecond();

    const vestor1LockPendingInitial = await autoRewardPool.pendingReward(vestor1.address);
    await autoRewardPool.connect(vestor1).claim();
    const vestor1LockPendingFinal = await autoRewardPool.pendingReward(vestor1.address);

    const vestor2LockPendingInitial = await autoRewardPool.pendingReward(vestor2.address);
    await autoRewardPool.connect(vestor2).claim();
    const vestor2LockPendingFinal = await autoRewardPool.pendingReward(vestor2.address);

    const vestor1DogeBal = await dogeCoin.balanceOf(vestor1.address);
    const vestor2DogeBal = await dogeCoin.balanceOf(vestor2.address);

    expect(vestor1LockPendingInitial).closeTo(parseEther("162").div(10**10),parseEther("1").div(10**10));
    expect(vestor2LockPendingInitial).closeTo(parseEther("325").div(10**10),parseEther("1").div(10**10));
    expect(vestor1DogeBal).to.eq(vestor1LockPendingInitial);
    expect(vestor2DogeBal).to.eq(vestor2LockPendingInitial);
    expect(vestor1LockPendingFinal).to.eq(0);
    expect(vestor2LockPendingFinal).to.eq(0);

  });
  it("DggLock: Should send 20% Flox before first epoch", async function() {
    await dggLock.connect(vestor1).claimDgg();
    const vestor1Bal = await flox.balanceOf(vestor1.address);
    expect(vestor1Bal).to.eq(parseEther("100000000"));
  });
  it("DggLock: Should send 40% Flox after first epoch before second epoch", async function() {
    await time.increase(2*86400);
    await dggLock.connect(vestor1).claimDgg();
    const vestor1Bal = await flox.balanceOf(vestor1.address);
    expect(vestor1Bal).to.eq(parseEther("300000000"));
  });
  it("DggLock: Should send remaining Flox after second epoch", async function() {
    await time.increase(2*86400);
    await dggLock.connect(vestor1).claimDgg();
    await dggLock.connect(vestor2).claimDgg();
    const vestor1Bal = await flox.balanceOf(vestor1.address);
    const vestor2Bal = await flox.balanceOf(vestor2.address);
    expect(vestor1Bal).to.eq(parseEther("500000000"));
    expect(vestor2Bal).to.eq(parseEther("1000000000"));
  });*/
});