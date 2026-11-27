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
    /// The owner's Solana wallet; `None` for a Canton-only profile.
    pub wallet: Option<String>,
    /// Canton parties the owner proved on the ledger and linked, oldest first.
    pub canton_parties: Vec<String>,
    pub username: String,
    pub display_name: String,
    pub bio: String,
    pub avatar_hue: i32,
    pub x_handle: Option<String>,
    pub show_on_leaderboards: bool,
    pub created_at: String,
    pub location: Option<String>,
    /// Full https URL.
    pub website: Option<String>,
    /// Handles below are stored without '@' or a site prefix.
    pub telegram: Option<String>,
    pub instagram: Option<String>,
    /// LinkedIn profile slug, as in linkedin.com/in/<slug>.
    pub linkedin: Option<String>,
    pub discord: Option<String>,
    pub github: Option<String>,
    pub youtube: Option<String>,
}

pub const PROFILE_COLUMNS: &str = "wallet,ARRAY(SELECT a.party FROM canton_accounts a WHERE a.user_id=profiles.user_id ORDER BY a.linked_at,a.party) AS canton_parties,username,display_name,bio,avatar_hue,x_handle,show_on_leaderboards,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS created_at,location,website,telegram,instagram,linkedin,discord,github,youtube";

pub fn profile_from_row(row: &PgRow) -> Profile {
    Profile {
        wallet: row.get("wallet"),
        canton_parties: row.get("canton_parties"),
        username: row.get("username"),
        display_name: row.get("display_name"),
        bio: row.get("bio"),
        avatar_hue: i32::from(row.get::<i16, _>("avatar_hue")),
        x_handle: row.get("x_handle"),
        show_on_leaderboards: row.get("show_on_leaderboards"),
        created_at: row.get("created_at"),
        location: row.get("location"),
        website: row.get("website"),
        telegram: row.get("telegram"),
        instagram: row.get("instagram"),
        linkedin: row.get("linkedin"),
        discord: row.get("discord"),
        github: row.get("github"),
        youtube: row.get("youtube"),
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
        .filter_map(|row| {
            let profile = profile_from_row(row);
            Some((profile.wallet.clone()?, profile))
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
    pub location: Option<String>,
    pub website: Option<String>,
    pub telegram: Option<String>,
    pub instagram: Option<String>,
    pub linkedin: Option<String>,
    pub discord: Option<String>,
    pub github: Option<String>,
    pub youtube: Option<String>,
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
    pub location: Option<String>,
    pub website: Option<String>,
    pub telegram: Option<String>,
    pub instagram: Option<String>,
    pub linkedin: Option<String>,
    pub discord: Option<String>,
    pub github: Option<String>,
    pub youtube: Option<String>,
}

/// A handle pasted as `@name`, `name` or a profile URL on one of `hosts`,
/// reduced to `name` and checked against `allowed` and `len`.
fn handle(
    value: Option<&str>,
    hosts: &[&str],
    len: std::ops::RangeInclusive<usize>,
    allowed: fn(u8) -> bool,
    error: &'static str,
) -> Result<Option<String>, &'static str> {
    let Some(raw) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let mut name = raw
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.");
    for host in hosts {
        if let Some(rest) = name.strip_prefix(host) {
            name = rest;
            break;
        }
    }
    let name = name.trim_start_matches('@').trim_end_matches('/');
    if !len.contains(&name.len()) || !name.bytes().all(allowed) {
        return Err(error);
    }
    Ok(Some(name.to_owned()))
}

fn word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
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
    let x_handle = handle(
        input.x_handle.as_deref(),
        &["x.com/", "twitter.com/"],
        1..=15,
        word,
        "X handles are up to 15 letters, numbers or _",
    )?;
    let location = match input.location.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(place) if place.chars().count() <= 40 && !place.chars().any(char::is_control) => {
            Some(place.to_owned())
        }
        Some(_) => return Err("Locations are up to 40 characters on one line"),
    };
    let website = match input.website.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(url) => {
            let url = if url.starts_with("https://") {
                url.to_owned()
            } else {
                format!("https://{}", url.trim_start_matches("http://"))
            };
            if url.len() > 120
                || url.len() <= "https://".len() + 3
                || !url["https://".len()..].contains('.')
                || url
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '"'))
            {
                return Err("Websites must be a valid https:// address up to 120 characters");
            }
            Some(url)
        }
    };
    let telegram = handle(
        input.telegram.as_deref(),
        &["t.me/", "telegram.me/"],
        5..=32,
        word,
        "Telegram usernames are 5–32 letters, numbers or _",
    )?;
    let instagram = handle(
        input.instagram.as_deref(),
        &["instagram.com/"],
        1..=30,
        |b| word(b) || b == b'.',
        "Instagram usernames are up to 30 letters, numbers, . or _",
    )?;
    let linkedin = handle(
        input.linkedin.as_deref(),
        &["linkedin.com/in/"],
        3..=100,
        |b| b.is_ascii_alphanumeric() || b == b'-',
        "LinkedIn profile names are 3–100 letters, numbers or -",
    )?;
    let discord = handle(
        input.discord.as_deref().map(str::to_lowercase).as_deref(),
        &[],
        2..=32,
        |b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.',
        "Discord usernames are 2–32 lowercase letters, numbers, . or _",
    )?;
    let github = handle(
        input.github.as_deref(),
        &["github.com/"],
        1..=39,
        |b| b.is_ascii_alphanumeric() || b == b'-',
        "GitHub usernames are up to 39 letters, numbers or -",
    )?;
    let youtube = handle(
        input.youtube.as_deref(),
        &["youtube.com/"],
        3..=30,
        |b| word(b) || b == b'.' || b == b'-',
        "YouTube handles are 3–30 letters, numbers, ., - or _",
    )?;
    Ok(ValidProfile {
        username,
        display_name,
        bio,
        avatar_hue,
        x_handle,
        show_on_leaderboards: input.show_on_leaderboards,
        location,
        website,
        telegram,
        instagram,
        linkedin,
        discord,
        github,
        youtube,
    })
}

#[derive(Default)]
pub struct ProfilesQuery;
#[Object]
impl ProfilesQuery {
    /// One profile by Solana wallet, username or linked Canton party.
    /// Exactly one is required.
    async fn profile(
        &self,
        ctx: &Context<'_>,
        wallet: Option<String>,
        username: Option<String>,
        party: Option<String>,
    ) -> async_graphql::Result<Option<Profile>> {
        let pool = &ctx.data::<ApiState>()?.pool;
        let row = match (wallet, username, party) {
            (None, None, Some(party)) => {
                if party.len() > 255 {
                    return Ok(None);
                }
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "SELECT {PROFILE_COLUMNS} FROM profiles WHERE user_id IN (SELECT user_id FROM canton_accounts WHERE party=$1)"
                )))
                .bind(party)
                .fetch_optional(pool)
                .await?
            }
            (Some(wallet), None, None) => {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "SELECT {PROFILE_COLUMNS} FROM profiles WHERE wallet=$1"
                )))
                .bind(wallet)
                .fetch_optional(pool)
                .await?
            }
            (None, Some(username), None) => {
                sqlx::query(sqlx::AssertSqlSafe(format!(
                    "SELECT {PROFILE_COLUMNS} FROM profiles WHERE username=$1"
                )))
                .bind(username.trim().to_lowercase())
                .fetch_optional(pool)
                .await?
            }
            _ => return Err("Provide exactly one of wallet, username or party".into()),
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
    /// Creates or replaces the signed-in user's profile (Solana or Canton sign-in).
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
            "INSERT INTO profiles(user_id,wallet,username,display_name,bio,avatar_hue,x_handle,show_on_leaderboards,location,website,telegram,instagram,linkedin,discord,github,youtube)
             VALUES($16::uuid,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT(user_id) DO UPDATE SET wallet=EXCLUDED.wallet,username=EXCLUDED.username,display_name=EXCLUDED.display_name,
               bio=EXCLUDED.bio,avatar_hue=EXCLUDED.avatar_hue,x_handle=EXCLUDED.x_handle,
               show_on_leaderboards=EXCLUDED.show_on_leaderboards,location=EXCLUDED.location,website=EXCLUDED.website,
               telegram=EXCLUDED.telegram,instagram=EXCLUDED.instagram,linkedin=EXCLUDED.linkedin,discord=EXCLUDED.discord,
               github=EXCLUDED.github,youtube=EXCLUDED.youtube,updated_at=NOW()
             RETURNING {PROFILE_COLUMNS}"
        )))
        .bind(&user.wallet)
        .bind(&profile.username)
        .bind(&profile.display_name)
        .bind(&profile.bio)
        .bind(profile.avatar_hue)
        .bind(&profile.x_handle)
        .bind(profile.show_on_leaderboards)
        .bind(&profile.location)
        .bind(&profile.website)
        .bind(&profile.telegram)
        .bind(&profile.instagram)
        .bind(&profile.linkedin)
        .bind(&profile.discord)
        .bind(&profile.github)
        .bind(&profile.youtube)
        .bind(&user.id)
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
            location: None,
            website: None,
            telegram: None,
            instagram: None,
            linkedin: None,
            discord: None,
            github: None,
            youtube: None,
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
    fn accepts_links_as_handles_or_urls() {
        let mut links = input("ada");
        links.x_handle = Some("https://x.com/ada_l/".into());
        links.website = Some("ada.dev/about".into());
        links.telegram = Some("https://t.me/ada_trades".into());
        links.instagram = Some("instagram.com/ada.l".into());
        links.linkedin = Some("https://www.linkedin.com/in/ada-lovelace/".into());
        links.discord = Some("Ada.L".into());
        links.github = Some("github.com/ada-l".into());
        links.youtube = Some("https://youtube.com/@AdaTrades".into());
        links.location = Some(" Lisbon ".into());
        let p = validate(links).unwrap();
        assert_eq!(p.x_handle.as_deref(), Some("ada_l"));
        assert_eq!(p.website.as_deref(), Some("https://ada.dev/about"));
        assert_eq!(p.telegram.as_deref(), Some("ada_trades"));
        assert_eq!(p.instagram.as_deref(), Some("ada.l"));
        assert_eq!(p.linkedin.as_deref(), Some("ada-lovelace"));
        assert_eq!(p.discord.as_deref(), Some("ada.l"));
        assert_eq!(p.github.as_deref(), Some("ada-l"));
        assert_eq!(p.youtube.as_deref(), Some("AdaTrades"));
        assert_eq!(p.location.as_deref(), Some("Lisbon"));
        for bad in ["javascript:alert(1)", "https://a b.com", "https://<x>.com"] {
            let mut links = input("ada");
            links.website = Some(bad.into());
            assert!(validate(links).is_err(), "{bad}");
        }
        let mut links = input("ada");
        links.telegram = Some("abc".into());
        assert!(validate(links).is_err(), "telegram needs 5+ characters");
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
