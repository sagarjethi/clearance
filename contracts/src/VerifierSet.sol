// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice The current verifiers and how many must sign. The hook and every account read from here,
/// so removing a verifier takes effect everywhere at once.
contract VerifierSet is Ownable {
    mapping(address => bool) public isVerifier;
    uint256 public verifierCount;
    uint256 public threshold;

    error InvalidThreshold();
    error AlreadyVerifier(address verifier);
    error NotAVerifier(address verifier);

    event VerifierAdded(address indexed verifier);
    event VerifierRemoved(address indexed verifier);
    event ThresholdChanged(uint256 threshold);

    constructor(address owner_, address[] memory verifiers, uint256 threshold_) Ownable(owner_) {
        for (uint256 i; i < verifiers.length; i++) {
            _add(verifiers[i]);
        }
        _setThreshold(threshold_);
    }

    function addVerifier(address verifier) external onlyOwner {
        _add(verifier);
    }

    function removeVerifier(address verifier) external onlyOwner {
        if (!isVerifier[verifier]) revert NotAVerifier(verifier);
        if (verifierCount - 1 < threshold) revert InvalidThreshold();
        isVerifier[verifier] = false;
        verifierCount--;
        emit VerifierRemoved(verifier);
    }

    function setThreshold(uint256 threshold_) external onlyOwner {
        _setThreshold(threshold_);
    }

    /// @notice True when `signatures` holds at least `threshold` signatures over `digest` from distinct
    /// current verifiers. Signatures must be sorted by signer address, which rules out duplicates.
    function hasQuorum(bytes32 digest, bytes[] memory signatures) public view returns (bool) {
        if (signatures.length < threshold) return false;
        address last;
        for (uint256 i; i < signatures.length; i++) {
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signatures[i]);
            if (err != ECDSA.RecoverError.NoError) return false;
            if (signer <= last || !isVerifier[signer]) return false;
            last = signer;
        }
        return true;
    }

    function _add(address verifier) private {
        if (verifier == address(0)) revert NotAVerifier(verifier);
        if (isVerifier[verifier]) revert AlreadyVerifier(verifier);
        isVerifier[verifier] = true;
        verifierCount++;
        emit VerifierAdded(verifier);
    }

    function _setThreshold(uint256 threshold_) private {
        if (threshold_ == 0 || threshold_ > verifierCount) revert InvalidThreshold();
        threshold = threshold_;
        emit ThresholdChanged(threshold_);
    }
}
