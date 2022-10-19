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
const DAI_TOKEN = "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3"; //used for testing rewards
const USDT_TOKEN = "0x55d398326f99059fF775485246999027B3197955"; //used for testing rewards
const PCS_FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const PCS_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const DEPLOYER = "0x70e1cB759996a1527eD1801B169621C18a9f38F9";


describe("FLOX", function () {
  let owner, manager, trader, trader1, trader2, trader3, feeDistributor;
  let deployer;
  let flox, czusd, busd, dai, usdt, pcsRouter, floxCzusdPair, autoRewardPool;
  before(async function () {
    [owner, manager, trader, trader1, trader2, trader3, feeDistributor] = await ethers.getSigners();
    await impersonateAccount(DEPLOYER);
    deployer = await ethers.getSigner(DEPLOYER);

    pcsRouter = await ethers.getContractAt("IAmmRouter02", PCS_ROUTER);
    czusd = await ethers.getContractAt("CZUsd", CZUSD_TOKEN);
    dai = await ethers.getContractAt("IERC20", DAI_TOKEN);
    usdt = await ethers.getContractAt("IERC20", USDT_TOKEN);
    busd = await ethers.getContractAt("IERC20", BUSD_TOKEN);

    const AutoRewardPool = await ethers.getContractFactory("AutoRewardPool_Variable");
    autoRewardPool = await AutoRewardPool.deploy();

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

    const floxCzusdPair_address = await flox.ammCzusdPair();
    floxCzusdPair = await ethers.getContractAt("IAmmPair", floxCzusdPair_address);

    await autoRewardPool.initialize(flox.address, floxCzusdPair.address);

    await flox.connect(manager).MANAGER_setRewardToken(
      dai.address,//address _rewardToken,
      WBNB_TOKEN//address _basePairToken
    );

    await czusd
      .connect(deployer)
      .grantRole(ethers.utils.id("MINTER_ROLE"), flox.address);

    await czusd.connect(deployer).mint(owner.address, INITIAL_CZUSD_LP_WAD);
    await flox.approve(pcsRouter.address, ethers.constants.MaxUint256);
    await czusd.approve(pcsRouter.address, ethers.constants.MaxUint256);

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
    await czusd.connect(deployer).mint(trader.address, parseEther("10000"));
    await czusd.connect(trader).approve(pcsRouter.address, ethers.constants.MaxUint256);

    await expect(pcsRouter.connect(trader).swapExactTokensForTokensSupportingFeeOnTransferTokens(
      parseEther("100"),
      0,
      [czusd.address, flox.address],
      trader.address,
      ethers.constants.MaxUint256
    )).to.be.reverted;
  });
  it("Should burn 18% when buying and increase wad available", async function () {
    await flox.ADMIN_openTrading();
    const totalStakedInitial = await autoRewardPool.totalStaked();
    const traderBalInitial = await flox.balanceOf(trader.address);
    await pcsRouter.connect(trader).swapExactTokensForTokensSupportingFeeOnTransferTokens(
      parseEther("100"),
      0,
      [czusd.address, flox.address],
      trader.address,
      ethers.constants.MaxUint256
    );
    const pendingReward = await autoRewardPool.pendingReward(1, trader.address);
    const { accTokenPerShare_,
      rewardPerSecond_,
      globalRewardDebt_,
      timestampLast_,
      timestampEnd_,
      totalStakedFinal_,
      totalRewardsPaid_,
      totalRewardsAdded_,
      rewardToken_ } = await autoRewardPool.getPool(1);
    const totalCzusdSpent = await flox.totalCzusdSpent();
    const lockedCzusd = await flox.lockedCzusd();
    const availableWadToSend = await flox.availableWadToSend();
    const totalSupply = await flox.totalSupply();
    const traderBalFinal = await flox.balanceOf(trader.address);

    expect(pendingReward).to.eq(0);
    expect(totalStakedFinal_.sub(totalStakedInitial)).to.eq(traderBalFinal.sub(traderBalInitial));
    expect(totalStakedInitial).to.eq(0);
    expect(rewardPerSecond_).to.eq(0);
    expect(totalCzusdSpent).to.eq(0);
    expect(lockedCzusd).to.be.closeTo(parseEther("42518.3"), parseEther("0.1"));
    expect(availableWadToSend).to.eq(lockedCzusd.sub(BASE_CZUSD_LP_WAD).sub(totalCzusdSpent));
    expect(totalSupply).to.be.closeTo(parseEther("999578518"), parseEther("1"));
  });
  it("Should send reward to dev wallet", async function () {
    const devWalletBalInitial = await ethers.provider.getBalance(manager.address);
    const autoRewardPoolBalInitial = await dai.balanceOf(autoRewardPool.address);
    const availableWadToSendInitial = await flox.availableWadToSend();
    await flox.performUpkeep(0);
    const devWalletBalFinal = await ethers.provider.getBalance(manager.address);
    const autoRewardPoolBalFinal = await dai.balanceOf(autoRewardPool.address);
    const availableWadToSendFinal = await flox.availableWadToSend();
    const totalCzusdSpent = await flox.totalCzusdSpent();
    const traderBal = await flox.balanceOf(trader.address);

    await flox.connect(trader).transfer(trader1.address, traderBal);
    const trader1Bal = await flox.balanceOf(trader1.address);

    await flox.connect(trader1).transfer(trader.address, trader1Bal);
    const { accTokenPerShare_,
      rewardPerSecond_,
      globalRewardDebt_,
      timestampLast_,
      timestampEnd_,
      totalStakedFinal_,
      totalRewardsPaid_,
      totalRewardsAdded_,
      rewardToken_ } = await autoRewardPool.getPool(1);

    expect(totalCzusdSpent).to.eq(availableWadToSendInitial);
    expect(totalCzusdSpent).to.be.closeTo(parseEther("18.3"), parseEther("0.1"));
    expect(availableWadToSendFinal).to.eq(0);
    expect(devWalletBalFinal.sub(devWalletBalInitial)).closeTo(parseEther("0.0238"), parseEther("0.0001"));
    expect(autoRewardPoolBalFinal.sub(autoRewardPoolBalInitial)).closeTo(parseEther("12.1"), parseEther("0.1"));
    expect(autoRewardPoolBalFinal.sub(autoRewardPoolBalInitial).div(86400 * 7)).to.be.eq(rewardPerSecond_);
    expect(rewardPerSecond_).to.be.closeTo(parseEther("0.00002"), parseEther("0.000001"));

  });
  it("Should properly set rps on second update", async function () {
    await time.increase(1 * 86400);
    await mine(1);
    const autoRewardPoolBalInitial = await dai.balanceOf(autoRewardPool.address);
    await pcsRouter.connect(trader).swapExactTokensForTokensSupportingFeeOnTransferTokens(
      parseEther("100"),
      0,
      [czusd.address, flox.address],
      trader.address,
      ethers.constants.MaxUint256
    );
    await flox.performUpkeep(0);
    await time.increase(10);
    await mine(1);
    const autoRewardPoolBalFinal = await dai.balanceOf(autoRewardPool.address);
    const traderBal = await flox.balanceOf(trader.address);
    await flox.connect(trader).transfer(trader1.address, traderBal);
    const trader1Bal = await flox.balanceOf(trader1.address);
    await flox.connect(trader1).transfer(trader.address, trader1Bal);
    const { accTokenPerShare_,
      rewardPerSecond_,
      globalRewardDebt_,
      timestampLast_,
      timestampEnd_,
      totalStakedFinal_,
      totalRewardsPaid_,
      totalRewardsAdded_,
      rewardToken_ } = await autoRewardPool.getPool(1);
    const {
      userRewardDebt_,
      totalRewardsReceived_,
      finalStakedBal_ } = await autoRewardPool.getPoolAccount(1, trader.address);
    const [
      userRewardDebt1_,
      totalRewardsReceived1_,
      finalStakedBal1_] = await autoRewardPool.getPoolAccount(1, trader1.address);
    const traderRewardBal = await dai.balanceOf(trader.address);
    const trader1RewardBal = await dai.balanceOf(trader1.address);
    const autoRewardPoolBalPostRewards = await dai.balanceOf(autoRewardPool.address);
    const currentTime = await time.latest();
    const traderPending = await autoRewardPool.pendingReward(1, trader.address);
    const trader1Pending = await autoRewardPool.pendingReward(1, trader1.address);
    expect(traderPending).to.be.closeTo(0, parseEther("0.01"));
    expect(trader1Pending).to.eq(0);
    expect(traderRewardBal).to.be.closeTo(parseEther("1.73"), parseEther("0.01"));
    expect(trader1RewardBal).to.be.closeTo(parseEther("0.00005"), parseEther("0.00001"));
    expect(totalRewardsReceived_).to.eq(traderRewardBal);
    expect(totalRewardsReceived1_).to.eq(trader1RewardBal);
    expect(totalRewardsPaid_).to.eq(traderRewardBal.add(trader1RewardBal))
    expect(autoRewardPoolBalFinal.sub(autoRewardPoolBalInitial)).closeTo(parseEther("10.3"), parseEther("0.1"));
    expect(rewardPerSecond_).to.be.closeTo(parseEther("0.00004"), parseEther("0.000001"));
    expect(rewardPerSecond_.mul(timestampEnd_.sub(currentTime))).closeTo(autoRewardPoolBalPostRewards, parseEther("5"));
  });
  it("Should properly set pending rewards with third trader and third update", async function () {
    await czusd.connect(deployer).mint(trader2.address, parseEther("10000"));
    await czusd.connect(trader2).approve(pcsRouter.address, ethers.constants.MaxUint256);
    await pcsRouter.connect(trader2).swapExactTokensForTokensSupportingFeeOnTransferTokens(
      parseEther("100"),
      0,
      [czusd.address, flox.address],
      trader2.address,
      ethers.constants.MaxUint256
    );
    const currentTimeInitial = await time.latest();
    await time.increase(1 * 86400);
    await mine(1);
    const currentTimeMiddle = await time.latest();
    const autoRewardPoolBalInitial = await dai.balanceOf(autoRewardPool.address);
    await flox.performUpkeep(0);
    const autoRewardPoolBalFinal = await dai.balanceOf(autoRewardPool.address);
    const traderBal = await flox.balanceOf(trader.address);
    await flox.connect(trader).transfer(trader1.address, traderBal);
    const trader1Bal = await flox.balanceOf(trader1.address);
    await flox.connect(trader1).transfer(trader.address, trader1Bal);
    const { accTokenPerShare_,
      rewardPerSecond_,
      globalRewardDebt_,
      timestampLast_,
      timestampEnd_,
      totalStakedFinal_,
      totalRewardsPaid_,
      totalRewardsAdded_,
      rewardToken_ } = await autoRewardPool.getPool(1);
    const autoRewardPoolBalPostRewards = await dai.balanceOf(autoRewardPool.address);
    const currentTimeFinal = await time.latest();
    const traderPending = await autoRewardPool.pendingReward(1, trader.address);
    const trader1Pending = await autoRewardPool.pendingReward(1, trader1.address);
    const trader2Pending = await autoRewardPool.pendingReward(1, trader2.address);

    expect(rewardPerSecond_).to.be.closeTo(parseEther("0.0000541"), parseEther("0.0000001"));
    expect(traderPending).to.be.closeTo(parseEther("0.00001"), parseEther("0.00001"));
    expect(trader1Pending).to.eq(0);
    expect(trader2Pending).to.be.closeTo(parseEther("1.14"), parseEther("0.01"));
    expect(rewardPerSecond_.mul(timestampEnd_.sub(currentTimeFinal.toString()))).to.be.closeTo(autoRewardPoolBalPostRewards.sub(trader2Pending), parseEther("2"));
  });
  it("Should change reward token", async function () {
    await flox.connect(manager).MANAGER_setRewardToken(
      usdt.address,//address _rewardToken,
      WBNB_TOKEN//address _basePairToken
    );
    const currentTime = await time.latest();
    const [accTokenPerShare1,
      rewardPerSecond1,
      globalRewardDebt1,
      timestampLast1,
      timestampEnd1,
      totalStakedFinal1,
      totalRewardsPaid1,
      totalRewardsAdded1,
      rewardToken1] = await autoRewardPool.getPool(1);
    const [accTokenPerShare2,
      rewardPerSecond2,
      globalRewardDebt2,
      timestampLast2,
      timestampEnd2,
      totalStakedFinal2,
      totalRewardsPaid2,
      totalRewardsAdded2,
      rewardToken2] = await autoRewardPool.getPool(2);
    const arpCurrentPoolId = await autoRewardPool.currentPoolId;
    const floxRewardToken = await flox.rewardToken();

    const trader2Pending1 = await autoRewardPool.pendingReward(1, trader2.address);
    const trader2Pending2 = await autoRewardPool.pendingReward(2, trader2.address);
    const trader1Pending1 = await autoRewardPool.pendingReward(1, trader1.address);
    const trader1Pending2 = await autoRewardPool.pendingReward(2, trader1.address);
    const traderPending1 = await autoRewardPool.pendingReward(1, trader.address);
    const traderPending2 = await autoRewardPool.pendingReward(2, trader.address);


    const autoRewardPoolBalDai = await dai.balanceOf(autoRewardPool.address);

    expect(rewardToken1).to.eq(dai.address);
    expect(rewardToken2).to.eq(usdt.address);
    expect(rewardPerSecond2).to.eq(0);
    expect(timestampEnd1).to.eq(currentTime);

    expect(traderPending2).to.eq(0);
    expect(trader1Pending2).to.eq(0);
    expect(trader2Pending2).to.eq(0);

    expect(autoRewardPoolBalDai).to.be.closeTo(traderPending1.add(trader1Pending1).add(trader2Pending1), parseEther("2"));

    expect(traderPending1).to.be.closeTo(parseEther("21.8"), parseEther("0.1"));
    expect(trader1Pending1).to.eq(0);
    expect(trader2Pending1).to.be.closeTo(parseEther("12.0"), parseEther("0.1"));;

  });
  it("Should properly set rps after token switch", async function () {
    await time.increase(1 * 86400);
    await mine(1);
    const autoRewardPoolBalInitial = await usdt.balanceOf(autoRewardPool.address);
    await pcsRouter.connect(trader).swapExactTokensForTokensSupportingFeeOnTransferTokens(
      parseEther("100"),
      0,
      [czusd.address, flox.address],
      trader.address,
      ethers.constants.MaxUint256
    );
    await flox.performUpkeep(0);
    await time.increase(1 * 86400);
    await mine(1);
    const autoRewardPoolBalFinal = await usdt.balanceOf(autoRewardPool.address);
    const traderBal = await flox.balanceOf(trader.address);
    const trader1BalInitial1 = await flox.balanceOf(trader1.address);
    const trader1PendingInitial1 = await autoRewardPool.pendingReward(2, trader1.address);
    const trader1RewardBalInitial1 = await usdt.balanceOf(trader1.address);
    await flox.connect(trader).transfer(trader1.address, traderBal);
    const trader1PendingInitial2 = await autoRewardPool.pendingReward(2, trader1.address);
    const trader1RewardBalInitial2 = await usdt.balanceOf(trader1.address);
    const trader1Bal = await flox.balanceOf(trader1.address);
    await flox.connect(trader1).transfer(trader.address, trader1Bal);
    const trader1PendingInitial3 = await autoRewardPool.pendingReward(2, trader1.address);
    const trader1RewardBalInitial3 = await usdt.balanceOf(trader1.address);
    const { accTokenPerShare_,
      rewardPerSecond_,
      globalRewardDebt_,
      timestampLast_,
      timestampEnd_,
      totalStakedFinal_,
      totalRewardsPaid_,
      totalRewardsAdded_,
      rewardToken_ } = await autoRewardPool.getPool(2);
    const {
      userRewardDebt_,
      totalRewardsReceived_,
      finalStakedBal_ } = await autoRewardPool.getPoolAccount(2, trader.address);
    const [
      userRewardDebt1_,
      totalRewardsReceived1_,
      finalStakedBal1_] = await autoRewardPool.getPoolAccount(2, trader1.address);
    const traderRewardBal = await usdt.balanceOf(trader.address);
    const trader1RewardBal = await usdt.balanceOf(trader1.address);
    const autoRewardPoolBalPostRewards = await usdt.balanceOf(autoRewardPool.address);
    await time.increase(1 * 86400);
    const currentTime = await time.latest();
    const traderPending = await autoRewardPool.pendingReward(2, trader.address);
    const trader1Pending = await autoRewardPool.pendingReward(2, trader1.address);
    const trader2Pending = await autoRewardPool.pendingReward(2, trader2.address);

    expect(traderPending).to.be.closeTo(parseEther("1.2"), parseEther("0.1"));
    expect(trader1Pending).to.eq(0);
    expect(trader2Pending).to.eq(0);
    //TODO: Double check that these values are correct
    expect(traderRewardBal).to.be.closeTo(parseEther("1.28"), parseEther("0.01"));
    expect(trader1RewardBal).to.be.closeTo(0, parseEther("0.0001"));
    expect(totalRewardsReceived_).to.eq(traderRewardBal);
    expect(totalRewardsReceived1_).to.eq(trader1RewardBal);
    expect(totalRewardsPaid_).to.eq(traderRewardBal.add(trader1RewardBal))
    expect(autoRewardPoolBalFinal.sub(autoRewardPoolBalInitial)).closeTo(parseEther("11.9"), parseEther("0.1"));
    expect(rewardPerSecond_).to.be.closeTo(parseEther("0.000019"), parseEther("0.000001"));
    expect(rewardPerSecond_.mul(timestampEnd_.sub(currentTime)).add(traderPending)).closeTo(autoRewardPoolBalPostRewards, parseEther("1"));
  });
});