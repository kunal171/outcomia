//! Club membership errors; append-only codes live in catalog.
pub use super::OutcomiaError::{
    AlreadyClubMember, ClubCounterMismatch, ClubFeeShareTooHigh, ClubInviteExpired,
    ClubInviteNotExpired, ClubOwnerProtected, InvalidClubMember, InvalidClubName,
    UnauthorizedClubAdmin, UnauthorizedClubOwner,
};
