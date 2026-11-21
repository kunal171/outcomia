//! Shared-wallet and resolution errors; numeric ABI remains in the central catalog.
pub use super::OutcomiaError::{
    InvalidAssetBalance, InvalidPredictionEvidence, InvalidSharedBook, InvalidSharedNeighbor,
    NothingToRedeem, PredictionCorrectionWindowClosed, PredictionFallbackUnavailable,
    PredictionNotResolved, PredictionProposalUnavailable, PredictionResolutionUnavailable,
    SharedBookMustBeClosed, SharedBookNotEmpty, SharedMarketKindMismatch,
    UnauthorizedPredictionResolver, UnauthorizedSharedOrderOwner,
};
