//! Protocol governance and administrator authorization errors.

pub use super::OutcomiaError::{
    AdminAlreadyActive, AdminAlreadyDisabled, AdminDisabled, AdminMustBeDisabled,
    CannotModifySuperAdmin, InvalidAdmin, InvalidDeployer, UnauthorizedAdmin,
    UnauthorizedSuperAdmin,
};
