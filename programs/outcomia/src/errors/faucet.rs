//! Errors for governance-controlled test-faucet initialization and claims.

pub use super::catalog::OutcomiaError::{
    FaucetMarketMismatch, FaucetMintMismatch, FaucetMintSupplyNotZero, FaucetMustBeClosed,
    InvalidFaucetClaimAmount, InvalidFaucetDestinationOwner, InvalidFaucetMintAuthority,
    UnauthorizedSuperAdmin,
};
