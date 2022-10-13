// SPDX-License-Identifier: GPL-3.0
// Authored by Plastic Digits
// Credit to Olive.cash, Pancakeswap
pragma solidity ^0.8.4;
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract AutoRewardPool_Variable is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Pool {
        uint256 accTokenPerShare;
        uint256 rewardPerSecond;
        uint256 globalRewardDebt;
        uint256 timestampLast;
        uint256 timestampEnd;
        uint256 totalStakedFinal;
        uint256 totalRewardsPaid;
        uint256 totalRewardsAdded;
        IERC20 rewardToken;
        mapping(address => uint256) userRewardDebt;
        mapping(address => uint256) totalRewardsReceived;
        mapping(address => uint256) finalStakedBal;
    }

    mapping(uint256 => Pool) pools;

    uint256 public currentPoolId;

    uint256 public totalStaked;

    uint256 public PRECISION_FACTOR;

    uint256 public period = 7 days;

    IERC20 public stakedToken;

    mapping(address => uint256) public stakedBal;

    //Pool ids up to this number which have had final claim
    mapping(address => uint256) public accountFinalClaimedTo;

    mapping(address => bool) isRewardExempt;

    bool isInitialized;

    function initialize(IERC20 _stakedToken, address _czusdPair)
        external
        onlyOwner
    {
        require(!isInitialized);
        isInitialized = true;
        stakedToken = _stakedToken;
        isRewardExempt[_czusdPair] = true;
        isRewardExempt[msg.sender] = true;

        PRECISION_FACTOR = uint256(10**12);
    }

    function getPool(uint256 _index)
        external
        view
        returns (
            uint256 accTokenPerShare_,
            uint256 rewardPerSecond_,
            uint256 globalRewardDebt_,
            uint256 timestampLast_,
            uint256 timestampEnd_,
            uint256 totalStakedFinal_,
            uint256 totalRewardsPaid_,
            uint256 totalRewardsAdded_,
            IERC20 rewardToken_
        )
    {
        accTokenPerShare_ = pools[_index].accTokenPerShare;
        rewardPerSecond_ = pools[_index].rewardPerSecond;
        globalRewardDebt_ = pools[_index].globalRewardDebt;
        timestampLast_ = pools[_index].timestampLast;
        timestampEnd_ = pools[_index].timestampEnd;
        totalStakedFinal_ = pools[_index].totalStakedFinal;
        totalRewardsPaid_ = pools[_index].totalRewardsPaid;
        totalRewardsAdded_ = pools[_index].totalRewardsAdded;
        rewardToken_ = pools[_index].rewardToken;
    }

    function getPoolAccount(uint256 _index, address _account)
        external
        view
        returns (
            uint256 userRewardDebt_,
            uint256 totalRewardsReceived_,
            uint256 finalStakedBal_
        )
    {
        userRewardDebt_ = pools[_index].userRewardDebt[_account];
        totalRewardsReceived_ = pools[_index].totalRewardsReceived[_account];
        finalStakedBal_ = pools[_index].finalStakedBal[_account];
    }

    function deposit(address _account, uint256 _amount) external {
        require(msg.sender == address(stakedToken), "ARP: Must be stakedtoken");
        _deposit(_account, _amount);
    }

    function airdrop(uint256 _wad) public {
        Pool storage pool = pools[currentPoolId];
        IERC20 rewardToken = pool.rewardToken;
        _updatePool(currentPoolId);
        rewardToken.transferFrom(msg.sender, address(this), _wad);
        pool.accTokenPerShare =
            pool.accTokenPerShare +
            ((_wad * PRECISION_FACTOR) / pool.totalStakedFinal);
    }

    function addRewardTokens(uint256 _wad) external {
        _updatePool(currentPoolId);

        Pool storage pool = pools[currentPoolId];
        IERC20 rewardToken = pool.rewardToken;
        rewardToken.transferFrom(msg.sender, address(this), _wad);

        pool.totalRewardsAdded += _wad;

        uint256 totalRewardsToDistribute = pool.totalRewardsAdded -
            ((pool.accTokenPerShare * pool.totalStakedFinal) /
                PRECISION_FACTOR);

        if (totalRewardsToDistribute > 0) {
            pool.rewardPerSecond = totalRewardsToDistribute / period;
            pool.timestampEnd = block.timestamp + period;
        }
    }

    function updateRewardToken(IERC20 _newToken) external {
        require(msg.sender == address(stakedToken), "ARP: Must be stakedtoken");
        //Cancel current pool's rps and airdrop all tokens to current stakers.
        Pool storage oldPool = pools[currentPoolId];
        _updatePool(currentPoolId);
        uint256 wadToAirdrop = oldPool.rewardPerSecond *
            _getMultiplier(
                currentPoolId,
                oldPool.timestampLast,
                oldPool.timestampEnd
            );
        oldPool.rewardPerSecond = 0;
        oldPool.timestampEnd = block.timestamp;
        oldPool.timestampLast = block.timestamp;
        oldPool.totalStakedFinal = totalStaked;
        oldPool.accTokenPerShare =
            oldPool.accTokenPerShare +
            ((wadToAirdrop * PRECISION_FACTOR) / oldPool.totalStakedFinal);

        //create new pool
        currentPoolId++;
        Pool storage pool = pools[currentPoolId];
        pool.timestampLast = block.timestamp;
        pool.rewardToken = _newToken;
        pool.totalStakedFinal = totalStaked;
    }

    function withdraw(address _account, uint256 _amount) external {
        require(msg.sender == address(stakedToken), "ARP: Must be stakedtoken");
        _withdraw(_account, _amount);
    }

    function claim() external {
        _claimAll(msg.sender);
    }

    function _claimAll(address _account) internal {
        for (
            uint256 i = accountFinalClaimedTo[_account] + 1;
            i <= currentPoolId;
            i++
        ) {
            _claimFor(i, _account);
        }
    }

    function _claimFor(uint256 _id, address _account) internal {
        require(
            accountFinalClaimedTo[_account] < _id,
            "ARP: Already claimed closed pool"
        );
        Pool storage pool = pools[currentPoolId];
        IERC20 rewardToken = pool.rewardToken;
        uint256 accountBal = stakedBal[_account];
        if (accountBal == 0) return; //nothing to claim
        if (_id != currentPoolId) {
            accountFinalClaimedTo[_account] = _id;
        }
        _updatePool(_id);
        if (accountBal > 0) {
            uint256 pending = ((accountBal) * pool.accTokenPerShare) /
                PRECISION_FACTOR -
                pool.userRewardDebt[_account];
            if (pending > 0) {
                rewardToken.safeTransfer(_account, pending);
                pool.totalRewardsPaid += pending;
                pool.totalRewardsReceived[_account] += pending;
            }
            pool.globalRewardDebt -= pool.userRewardDebt[_account];
            pool.userRewardDebt[_account] =
                (accountBal * pool.accTokenPerShare) /
                PRECISION_FACTOR;
            pool.globalRewardDebt += pool.userRewardDebt[_account];
        }
    }

    function _deposit(address _account, uint256 _amount) internal {
        if (isRewardExempt[_account]) return;
        if (_amount == 0) return;

        _claimAll(_account);

        //If the account has nothing staked, then do not need to claim old pools
        if (stakedBal[_account] == 0)
            accountFinalClaimedTo[_account] == currentPoolId - 1;

        Pool storage pool = pools[currentPoolId];

        pool.globalRewardDebt -= pool.userRewardDebt[_account];
        stakedBal[_account] += _amount;
        pool.userRewardDebt[_account] =
            (stakedBal[_account] * pool.accTokenPerShare) /
            PRECISION_FACTOR;
        pool.globalRewardDebt += pool.userRewardDebt[_account];
        totalStaked += _amount;
        pool.totalStakedFinal = totalStaked;
        pool.finalStakedBal[_account] = stakedBal[_account];
    }

    /*
     * @notice Withdraw staked tokens and collect reward tokens
     * @param _amount: amount to withdraw (in rewardToken)
     */
    function _withdraw(address _account, uint256 _amount) internal {
        if (isRewardExempt[_account]) return;
        if (_amount == 0) return;

        _claimAll(_account);

        Pool storage pool = pools[currentPoolId];

        pool.globalRewardDebt -= pool.userRewardDebt[_account];
        stakedBal[_account] -= _amount;
        pool.userRewardDebt[_account] =
            (stakedBal[_account] * pool.accTokenPerShare) /
            PRECISION_FACTOR;
        pool.globalRewardDebt += pool.userRewardDebt[_account];
        totalStaked -= _amount;
        pool.totalStakedFinal = totalStaked;
        pool.finalStakedBal[_account] = stakedBal[_account];
    }

    function setIsRewardExempt(address _for, bool _to) public onlyOwner {
        if (isRewardExempt[_for] == _to) return;
        if (_to) {
            _withdraw(_for, stakedBal[_for]);
        } else {
            _deposit(_for, stakedBal[_for]);
        }
        isRewardExempt[_for] = _to;
    }

    /**
     * @notice It allows the admin to recover wrong tokens sent to the contract
     * @param _tokenAddress: the address of the token to withdraw
     * @param _tokenAmount: the number of tokens to withdraw
     * @dev This function is only callable by admin.
     */
    function recoverWrongTokens(address _tokenAddress, uint256 _tokenAmount)
        external
        onlyOwner
    {
        IERC20(_tokenAddress).safeTransfer(address(msg.sender), _tokenAmount);
    }

    /*
     * @notice View function to see pending reward on frontend.
     * @param _user: user address
     * @return Pending reward for a given user
     */
    function pendingReward(uint256 _id, address _user)
        external
        view
        returns (uint256)
    {
        Pool storage pool = pools[currentPoolId];
        if (
            block.timestamp > pool.timestampLast && pool.totalStakedFinal != 0
        ) {
            uint256 adjustedTokenPerShare = pool.accTokenPerShare +
                ((pool.rewardPerSecond *
                    _getMultiplier(_id, pool.timestampLast, block.timestamp) *
                    PRECISION_FACTOR) / pool.totalStakedFinal);
            return
                (pool.finalStakedBal[_user] * adjustedTokenPerShare) /
                PRECISION_FACTOR -
                pool.userRewardDebt[_user];
        } else {
            return
                (pool.finalStakedBal[_user] * pool.accTokenPerShare) /
                PRECISION_FACTOR -
                pool.userRewardDebt[_user];
        }
    }

    /*
     * @notice Update reward variables of the given pool to be up-to-date.
     */
    function _updatePool(uint256 _id) internal {
        Pool storage pool = pools[_id];

        if (block.timestamp <= pool.timestampLast) {
            return;
        }

        if (totalStaked == 0) {
            pool.timestampLast = block.timestamp;
            return;
        }

        if (_id == currentPoolId) {
            pool.totalStakedFinal = totalStaked;
        }

        pool.accTokenPerShare =
            pool.accTokenPerShare +
            ((pool.rewardPerSecond *
                _getMultiplier(_id, pool.timestampLast, block.timestamp) *
                PRECISION_FACTOR) / pool.totalStakedFinal);

        pool.timestampLast = block.timestamp;
    }

    /*
     * @notice Return reward multiplier over the given _from to _to timestamp.
     * @param _from: timestamp to start
     * @param _to: timestamp to finish
     */
    function _getMultiplier(
        uint256 _id,
        uint256 _from,
        uint256 _to
    ) internal view returns (uint256) {
        Pool storage pool = pools[_id];
        if (_to <= pool.timestampEnd) {
            return _to - _from;
        } else if (_from >= pool.timestampEnd) {
            return 0;
        } else {
            return pool.timestampEnd - _from;
        }
    }
}
