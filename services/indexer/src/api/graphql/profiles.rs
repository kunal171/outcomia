//! Public profiles: read by anyone, written only by the signed-in wallet.
use crate::api::{ApiState, SameOrigin};
use crate::auth;
use async_graphql::{Context, InputObject, Object, SimpleObject};
use sqlx::{postgres::PgRow, PgPool, Row};

/// Usernames that could impersonate the service or collide with routes.
const RESERVED: &[&str] = &[
    "admin",
    "administrator",
    "api",
    "faucet",
    "help",
    "leaderboard",
    "me",
    "mod",
    "moderator",
    "null",
    "official",
    "outcomia",
    "profile",
    "root",
    "settings",
    "staff",
    "support",
    "system",
    "team",
    "undefined",
    "wallet",
];

#[derive(SimpleObject, Clone)]
pub struct Profile {
    pub wallet: String,
    pub username: String,
    pub display_name: String,
    pub bio: String,
    pub avatar_hue: i32,
    pub x_handle: Option<String>,
    pub show_on_leaderboards: bool,
    pub created_at: String,
}

pub const PROFILE_COLUMNS: &str = "wallet,username,display_name,bio,avatar_hue,x_handle,show_on_leaderboards,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at";

pub fn profile_from_row(row: &PgRow) -> Profile {
    Profile {
        wallet: row.get("wallet"),
        username: row.get("username"),
        display_name: row.get("display_name"),
        bio: row.get("bio"),
        avatar_hue: i32::from(row.get::<i16, _>("avatar_hue")),
        x_handle: row.get("x_handle"),
        show_on_leaderboards: row.get("show_on_leaderboards"),
        created_at: row.get("created_at"),
    }
}

/// Inputs: wallet addresses. Returns: the profiles that exist, by wallet.
pub async fn profiles_for(
    pool: &PgPool,
    wallets: &[String],
) -> sqlx::Result<std::collections::HashMap<String, Profile>> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {PROFILE_COLUMNS} FROM profiles WHERE wallet = ANY($1)"
    )))
    .bind(wallets)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row| {
            let profile = profile_from_row(row);
            (profile.wallet.clone(), profile)
        })
        .collect())
}

#[derive(InputObject)]
pub struct ProfileInput {
    pub username: String,
    pub display_name: String,
    pub bio: String,
    pub avatar_hue: i32,
    pub x_handle: Option<String>,
    pub show_on_leaderboards: bool,
}

/// Normalized, validated profile fields ready to store.
#[derive(Debug, PartialEq)]
pub struct ValidProfile {
    pub username: String,
    pub display_name: String,
    pub bio: String,
    pub avatar_hue: i16,
    pub x_handle: Option<String>,
    pub show_on_leaderboards: bool,
}

/// Inputs: raw profile input. Errors: a message the user can act on.
/// Returns: trimmed values that satisfy the table's constraints.
pub fn validate(input: ProfileInput) -> Result<ValidProfile, &'static str> {
    let username = input.username.trim().to_lowercase();
    if !(3..=20).contains(&username.len())
        || !username
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return Err("Usernames are 3–20 characters: letters, numbers and _");
    }
    if RESERVED.contains(&username.as_str()) {
        return Err("That username is reserved");
    }
    let display_name = input.display_name.trim().to_owned();
    if display_name.chars().count() > 40 || display_name.chars().any(char::is_control) {
        return Err("Display names are up to 40 characters on one line");
    }
    let bio = input.bio.trim().to_owned();
    if bio.chars().count() > 280 || bio.chars().any(|c| c.is_control() && c != '\n') {
        return Err("Bios are up to 280 characters");
    }
    let avatar_hue = i16::try_from(input.avatar_hue)
        .ok()
        .filter(|hue| (0..360).contains(hue))
        .ok_or("Avatar colour must be between 0 and 359")?;
    let x_handle = match input.x_handle.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(handle) => {
            let handle = handle.trim_start_matches('@');
            if !(1..=15).contains(&handle.len())
                || !handle
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                return Err("X handles are up to 15 letters, numbers or _");
            }
            Some(handle.to_owned())
        }
    };
    Ok(ValidProfile {
        username,
        display_name,
        bio,
        avatar_hue,
        x_handle,
        show_on_leaderboards: input.show_on_leaderboards,
    })
}

#[derive(Default)]
pub struct ProfilesQuery;
#[Object]
impl ProfilesQuery {
    /// One profile by wallet address or username. Exactly one is required.
    async fn profile(
        &self,
        ctx: &Context<'_>,
        wallet: Option<String>,
        username: Option<String>,
    ) -> async_graphql::Result<Option<Profile>> {
        let pool = &ctx.data::<ApiState>()?.pool;
        let row = match (wallet, username) {
            (Some(wallet), None) => {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "SELECT {PROFILE_COLUMNS} FROM profiles WHERE wallet=$1"
                )))
                .bind(wallet)
                .fetch_optional(pool)
                .await?
            }
            (None, Some(username)) => {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "SELECT {PROFILE_COLUMNS} FROM profiles WHERE username=$1"
                )))
                .bind(username.trim().to_lowercase())
                .fetch_optional(pool)
                .await?
            }
            _ => return Err("Provide either a wallet or a username".into()),
        };
        Ok(row.as_ref().map(profile_from_row))
    }

    /// Profiles for up to 100 wallets, so lists can show names in one request.
    async fn profiles(
        &self,
        ctx: &Context<'_>,
        wallets: Vec<String>,
    ) -> async_graphql::Result<Vec<Profile>> {
        if wallets.len() > 100 || wallets.iter().any(|w| w.len() > 64) {
            return Err("Ask for at most 100 wallets".into());
        }
        let pool = &ctx.data::<ApiState>()?.pool;
        let mut found = profiles_for(pool, &wallets).await?;
        Ok(wallets.iter().filter_map(|w| found.remove(w)).collect())
    }
}

#[derive(Default)]
pub struct ProfilesMutation;
#[Object]
impl ProfilesMutation {
    /// Creates or replaces the signed-in wallet's profile.
    async fn update_profile(
        &self,
        ctx: &Context<'_>,
        input: ProfileInput,
    ) -> async_graphql::Result<Profile> {
        // Cookies authenticate the session, so require the app's own origin
        // as well: another site must not be able to submit this for a user.
        let same_origin = ctx.data_opt::<SameOrigin>().is_some_and(|s| s.0);
        let user = ctx.data::<Option<auth::User>>()?.as_ref();
        let (true, Some(user)) = (same_origin, user) else {
            return Err("Sign in with your wallet to edit your profile".into());
        };
        let profile = validate(input).map_err(async_graphql::Error::new)?;
        let pool = &ctx.data::<ApiState>()?.pool;
        let result = sqlx::query(sqlx::AssertSqlSafe(format!(
            "INSERT INTO profiles(wallet,username,display_name,bio,avatar_hue,x_handle,show_on_leaderboards)
             VALUES($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT(wallet) DO UPDATE SET username=EXCLUDED.username,display_name=EXCLUDED.display_name,
               bio=EXCLUDED.bio,avatar_hue=EXCLUDED.avatar_hue,x_handle=EXCLUDED.x_handle,
               show_on_leaderboards=EXCLUDED.show_on_leaderboards,updated_at=NOW()
             RETURNING {PROFILE_COLUMNS}"
        )))
        .bind(&user.wallet)
        .bind(&profile.username)
        .bind(&profile.display_name)
        .bind(&profile.bio)
        .bind(profile.avatar_hue)
        .bind(&profile.x_handle)
        .bind(profile.show_on_leaderboards)
        .fetch_one(pool)
        .await;
        match result {
            Ok(row) => Ok(profile_from_row(&row)),
            Err(sqlx::Error::Database(e)) if e.constraint() == Some("profiles_username") => {
                Err("That username is taken".into())
            }
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(username: &str) -> ProfileInput {
        ProfileInput {
            username: username.into(),
            display_name: "  Ada  ".into(),
            bio: "Calls markets early.\nMostly right.".into(),
            avatar_hue: 120,
            x_handle: Some("@ada_l".into()),
            show_on_leaderboards: true,
        }
    }

    #[test]
    fn normalizes_valid_profiles() {
        let profile = validate(input("  Ada_99 ")).unwrap();
        assert_eq!(profile.username, "ada_99");
        assert_eq!(profile.display_name, "Ada");
        assert_eq!(profile.x_handle.as_deref(), Some("ada_l"));
        assert_eq!(profile.avatar_hue, 120);
    }

    #[test]
    fn rejects_unsafe_or_reserved_values() {
        for name in [
            "ab",
            "a-b-c",
            "this_name_is_far_too_long",
            "admin",
            "Outcomia",
            "ad min",
        ] {
            assert!(validate(input(name)).is_err(), "{name}");
        }
        let mut bad = input("valid_name");
        bad.display_name = "line\u{7}bell".into();
        assert!(validate(bad).is_err());
        let mut bad = input("valid_name");
        bad.avatar_hue = 360;
        assert!(validate(bad).is_err());
        let mut bad = input("valid_name");
        bad.x_handle = Some("not a handle".into());
        assert!(validate(bad).is_err());
        let mut bad = input("valid_name");
        bad.bio = "x".repeat(281);
        assert!(validate(bad).is_err());
    }
}
