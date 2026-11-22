//! Club membership errors; append-only codes live in catalog.
pub use super::OutcomiaError::{
    AlreadyClubMember, ClubCounterMismatch, ClubInviteExpired, ClubInviteNotExpired,
    ClubOwnerProtected, InvalidClubMember, InvalidClubName, UnauthorizedClubAdmin,
    UnauthorizedClubOwner,
};
