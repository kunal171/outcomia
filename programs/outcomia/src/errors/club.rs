//! Club membership errors; append-only codes live in catalog.
pub use super::OutcomiaError::{
    AlreadyClubMember, ClubCounterMismatch, ClubFeeShareTooHigh, ClubInviteExpired,
    ClubInviteNotExpired, ClubMembershipRequired, ClubOwnerProtected, InvalidClubMarket,
    InvalidClubMember, InvalidClubName, UnauthorizedClubAdmin, UnauthorizedClubOwner,
};
