//! Decode the checked-in Anchor IDL without rounding u64 balances or IDs.
use serde_json::{json, Map, Value};
use std::{io, sync::OnceLock};

pub const IDL_BYTES: &str = include_str!("../../../../app/idl/outcomia.json");
/// Earlier deployed IDLs, newest first. Program upgrades can change an
/// instruction's arguments or accounts and an account's layout; history and
/// not-yet-migrated accounts written under an older IDL still decode with it.
/// Each entry must stay byte-identical to the IDL it records, because its
/// hash also lets a database bound to it move to the current IDL.
pub const IDL_HISTORY: &[&str] = &[
    include_str!("../../../../app/idl/history/outcomia-2026-11-28.json"),
    include_str!("../../../../app/idl/history/outcomia-2026-11-27.json"),
    include_str!("../../../../app/idl/history/outcomia-2026-11-23.json"),
];
pub fn idl() -> &'static Value {
    &idl_versions()[0]
}
/// The current IDL followed by `IDL_HISTORY`.
pub fn idl_versions() -> &'static [Value] {
    static IDLS: OnceLock<Vec<Value>> = OnceLock::new();
    IDLS.get_or_init(|| {
        std::iter::once(IDL_BYTES)
            .chain(IDL_HISTORY.iter().copied())
            .map(|bytes| serde_json::from_str(bytes).expect("checked-in IDL"))
            .collect()
    })
}
pub fn camel(name: &str) -> String {
    let mut upper = false;
    name.chars()
        .enumerate()
        .filter_map(|(i, c)| {
            if c == '_' {
                upper = true;
                None
            } else if upper {
                upper = false;
                Some(c.to_ascii_uppercase())
            } else if i == 0 {
                Some(c.to_ascii_lowercase())
            } else {
                Some(c)
            }
        })
        .collect()
}
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
fn take<'a>(input: &mut &'a [u8], n: usize) -> io::Result<&'a [u8]> {
    if input.len() < n {
        return Err(invalid("truncated Borsh data"));
    }
    let (value, rest) = input.split_at(n);
    *input = rest;
    Ok(value)
}
fn fields(idl: &Value, fields: &[Value], input: &mut &[u8], depth: usize) -> io::Result<Value> {
    if fields.first().is_some_and(|f| f.get("name").is_none()) {
        return fields
            .iter()
            .map(|f| decode_in(idl, f, input, depth + 1))
            .collect::<io::Result<Vec<_>>>()
            .map(Value::Array);
    }
    let mut object = Map::new();
    for field in fields {
        object.insert(
            camel(
                field["name"]
                    .as_str()
                    .ok_or_else(|| invalid("field name"))?,
            ),
            decode_in(idl, &field["type"], input, depth + 1)?,
        );
    }
    Ok(Value::Object(object))
}
#[cfg(test)]
pub fn decode(ty: &Value, input: &mut &[u8], depth: usize) -> io::Result<Value> {
    decode_in(idl(), ty, input, depth)
}
fn decode_in(idl: &Value, ty: &Value, input: &mut &[u8], depth: usize) -> io::Result<Value> {
    if depth > 32 {
        return Err(invalid("IDL recursion limit"));
    }
    if let Some(name) = ty.as_str() {
        return match name {
            "u8" => Ok(json!(take(input, 1)?[0])),
            "u16" => Ok(json!(u16::from_le_bytes(
                take(input, 2)?.try_into().unwrap()
            ))),
            "u32" => Ok(json!(u32::from_le_bytes(
                take(input, 4)?.try_into().unwrap()
            ))),
            "u64" => Ok(json!(u64::from_le_bytes(
                take(input, 8)?.try_into().unwrap()
            )
            .to_string())),
            "i64" => Ok(json!(i64::from_le_bytes(
                take(input, 8)?.try_into().unwrap()
            )
            .to_string())),
            "u128" => Ok(json!(u128::from_le_bytes(
                take(input, 16)?.try_into().unwrap()
            )
            .to_string())),
            "bool" => match take(input, 1)?[0] {
                0 => Ok(json!(false)),
                1 => Ok(json!(true)),
                _ => Err(invalid("invalid boolean")),
            },
            "pubkey" => Ok(json!(bs58::encode(take(input, 32)?).into_string())),
            "string" | "bytes" => {
                let n = u32::from_le_bytes(take(input, 4)?.try_into().unwrap()) as usize;
                let bytes = take(input, n)?;
                if name == "string" {
                    Ok(json!(
                        std::str::from_utf8(bytes).map_err(|_| invalid("invalid UTF-8"))?
                    ))
                } else {
                    Ok(json!(bytes))
                }
            }
            _ => Err(invalid(&format!("unsupported IDL primitive {name}"))),
        };
    }
    if let Some(inner) = ty.get("option") {
        return match take(input, 1)?[0] {
            0 => Ok(Value::Null),
            1 => decode_in(idl, inner, input, depth + 1),
            _ => Err(invalid("invalid option")),
        };
    }
    if ty.get("array").is_some() || ty.get("vec").is_some() {
        let (inner, n) = if let Some(array) = ty.get("array") {
            (
                &array[0],
                array[1].as_u64().ok_or_else(|| invalid("array length"))? as usize,
            )
        } else {
            (
                &ty["vec"],
                u32::from_le_bytes(take(input, 4)?.try_into().unwrap()) as usize,
            )
        };
        if n > 131072 || n > input.len() {
            return Err(invalid("invalid collection length"));
        }
        return (0..n)
            .map(|_| decode_in(idl, inner, input, depth + 1))
            .collect::<io::Result<Vec<_>>>()
            .map(Value::Array);
    }
    if let Some(name) = ty.pointer("/defined/name").and_then(Value::as_str) {
        let definition = idl["types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .ok_or_else(|| invalid("unknown IDL definition"))?;
        let body = &definition["type"];
        return match body["kind"].as_str() {
            Some("struct") => fields(
                idl,
                body["fields"]
                    .as_array()
                    .ok_or_else(|| invalid("struct fields"))?,
                input,
                depth + 1,
            ),
            Some("enum") => {
                let index = take(input, 1)?[0] as usize;
                let variant = body["variants"]
                    .get(index)
                    .ok_or_else(|| invalid("invalid enum variant"))?;
                let payload = if let Some(f) = variant["fields"].as_array() {
                    fields(idl, f, input, depth + 1)?
                } else {
                    json!({})
                };
                let mut value = Map::new();
                value.insert(camel(variant["name"].as_str().unwrap()), payload);
                Ok(Value::Object(value))
            }
            _ => Err(invalid("unsupported IDL definition")),
        };
    }
    Err(invalid("unsupported IDL type"))
}
pub fn decode_account(bytes: &[u8]) -> io::Result<(String, Value)> {
    if bytes.len() > 131072 || bytes.len() < 8 {
        return Err(invalid("invalid account data length"));
    }
    let mut last = invalid("unknown account discriminator; check deployed IDL");
    for idl in idl_versions() {
        let Some(definition) = idl["accounts"].as_array().unwrap().iter().find(|a| {
            a["discriminator"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .all(|(i, n)| n.as_u64() == Some(bytes[i] as u64))
        }) else {
            continue;
        };
        let name = definition["name"].as_str().unwrap();
        let mut input = &bytes[8..];
        // Bytes after a complete decode are ignored, as Anchor's own account
        // deserialization does. Accounts keep their original allocation, and
        // Anchor does not zero the tail when an encoding shrinks: an Option that
        // returns to None or a shorter string leaves stale bytes behind. Rejecting
        // them made one emptied order book fail every account scan. Truncated or
        // malformed data still fails inside decode. An account written under an
        // older layout (not migrated yet) decodes with the IDL that wrote it.
        match decode_in(idl, &json!({"defined":{"name":name}}), &mut input, 0) {
            Ok(value) => return Ok((name.to_owned(), value)),
            Err(error) => last = error,
        }
    }
    Err(last)
}

/// Decodes an instruction with the newest IDL whose arguments decode exactly
/// and whose account list fits in `accounts`, returning its account roles.
/// The current IDL is tried first, so a newer instruction never decodes with
/// an older role list.
pub fn decode_instruction_roles(
    bytes: &[u8],
    accounts: usize,
) -> io::Result<(String, Value, Vec<String>)> {
    if bytes.len() < 8 || bytes.len() > 131072 {
        return Err(invalid("invalid instruction length"));
    }
    let mut last = invalid("unknown instruction discriminator");
    for idl in idl_versions() {
        let Some(definition) = idl["instructions"].as_array().unwrap().iter().find(|a| {
            a["discriminator"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .all(|(i, n)| n.as_u64() == Some(bytes[i] as u64))
        }) else {
            continue;
        };
        let roles = definition["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                r["name"]
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| invalid("grouped instruction accounts unsupported"))
            })
            .collect::<io::Result<Vec<_>>>()?;
        if roles.len() > accounts {
            last = invalid("truncated instruction account list");
            continue;
        }
        let mut body = &bytes[8..];
        match fields(idl, definition["args"].as_array().unwrap(), &mut body, 0) {
            Ok(args) if body.is_empty() => {
                return Ok((definition["name"].as_str().unwrap().to_owned(), args, roles))
            }
            Ok(_) => last = invalid("trailing instruction bytes"),
            Err(error) => last = error,
        }
    }
    Err(last)
}

/// Common public-key filters use projection indexes; other memcmp filters retain
/// byte-exact semantics. Dynamic fields stop fixed-offset discovery.
pub fn indexed_filter_field(account_type: &str, offset: i32, length: usize) -> Option<String> {
    if length != 32 {
        return None;
    }
    let definition = idl()["types"]
        .as_array()?
        .iter()
        .find(|d| d["name"] == account_type)?;
    let mut position = 8_i32;
    for field in definition["type"]["fields"].as_array()? {
        let ty = &field["type"];
        if position == offset && ty == "pubkey" {
            let name = camel(field["name"].as_str()?);
            return ["owner", "market", "book", "mint", "authority"]
                .contains(&name.as_str())
                .then_some(name);
        }
        let width = match ty.as_str() {
            Some("pubkey") => 32,
            Some("u64" | "i64") => 8,
            Some("u32" | "i32") => 4,
            Some("u16" | "i16") => 2,
            Some("u8" | "i8" | "bool") => 1,
            _ => return None,
        };
        position += width;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn agrees_with_anchor_for_every_account_layout() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let fixtures: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/account-wire.json")).unwrap();
        assert_eq!(
            fixtures.as_array().unwrap().len(),
            idl()["accounts"].as_array().unwrap().len()
        );
        for fixture in fixtures.as_array().unwrap() {
            let (name, data) =
                decode_account(&STANDARD.decode(fixture["bytes"].as_str().unwrap()).unwrap())
                    .unwrap();
            assert_eq!(name, fixture["name"].as_str().unwrap());
            assert_eq!(data, fixture["expected"], "{name}");
        }
    }
    #[test]
    fn exact_balances_and_tuple_enum_wire_shapes() {
        let mut bytes = vec![2; 64];
        bytes.extend(u64::MAX.to_le_bytes());
        bytes.extend(17_u64.to_le_bytes());
        bytes.push(254);
        let mut account = vec![0; 8];
        let def = idl()["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == "AssetBalance")
            .unwrap();
        for (i, n) in def["discriminator"].as_array().unwrap().iter().enumerate() {
            account[i] = n.as_u64().unwrap() as u8;
        }
        account.extend(bytes);
        let (_, value) = decode_account(&account).unwrap();
        assert_eq!(value["free"], u64::MAX.to_string());
        assert_eq!(value["locked"], "17");
        let ty = json!({"defined":{"name":"MultiOutcomeResolution"}});
        assert_eq!(
            decode(&ty, &mut &[0, 7][..], 0).unwrap(),
            json!({"winner":[[7]]})
        );
        assert!(decode(&ty, &mut &[3][..], 0).is_err());
        // Stale allocation bytes after a complete decode are ignored.
        account.push(1);
        let (_, stale) = decode_account(&account).unwrap();
        assert_eq!(stale, value);
        // Removing a byte from the encoded fields is still rejected.
        account.truncate(account.len() - 2);
        assert!(decode_account(&account).is_err());
    }
    #[test]
    fn shrunk_option_leaves_ignorable_stale_bytes() {
        // A SharedBook whose best price returns to None keeps the old price
        // bytes after its now-shorter encoding, exactly as seen on devnet.
        let def = idl()["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["name"] == "SharedBook")
            .unwrap();
        let mut head: Vec<u8> = def["discriminator"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u8)
            .collect();
        head.extend([1; 32]); // market
        head.extend([2; 32]); // authority
        head.push(0); // kind: Spot
        head.extend([3; 32]); // base_mint
        head.extend([4; 32]); // quote_mint
        head.extend([9, 6]); // decimals
        head.extend(10_000_u64.to_le_bytes()); // price_tick
        head.extend(1_000_u64.to_le_bytes()); // quantity_lot
        head.extend(0_u64.to_le_bytes()); // payout_per_contract
        let tail = |best: [Option<u64>; 4]| {
            let mut bytes = Vec::new();
            for price in best {
                match price {
                    Some(p) => {
                        bytes.push(1);
                        bytes.extend(p.to_le_bytes());
                    }
                    None => bytes.push(0),
                }
            }
            bytes.extend(5_u64.to_le_bytes()); // next_order_id
            bytes.extend(0_u64.to_le_bytes()); // open_order_count
            bytes.extend(0_u64.to_le_bytes()); // accrued_quote_fees
            bytes.push(254); // bump
            bytes
        };
        // Allocation sized for the earlier, longer encoding with a best bid.
        let mut before = head.clone();
        before.extend(tail([Some(777), None, None, None]));
        let mut after = head.clone();
        after.extend(tail([None, None, None, None]));
        let mut account = after.clone();
        account.extend(&before[after.len()..]); // stale, nonzero bytes remain
        assert!(account[after.len()..].iter().any(|b| *b != 0));
        let (name, value) = decode_account(&account).unwrap();
        assert_eq!(name, "SharedBook");
        assert_eq!(value, decode_account(&after).unwrap().1);
        assert_eq!(value["bestPrices"], json!([null, null, null, null]));
    }
    #[test]
    fn rejects_truncation_and_adversarial_lengths() {
        assert!(decode_account(&[0; 8]).is_err());
        assert!(decode(&json!({"vec":"u8"}), &mut &[255; 4][..], 0).is_err());
        assert!(decode(&json!({"option":"u8"}), &mut &[2][..], 0).is_err());
        assert!(decode(&json!("bool"), &mut &[2][..], 0).is_err());
        assert_eq!(camel("yes_best_bid"), "yesBestBid");
        assert_eq!(
            indexed_filter_field("SharedOrder", 72, 32).as_deref(),
            Some("book")
        );
        assert_eq!(
            indexed_filter_field("PredictionPosition", 40, 32).as_deref(),
            Some("owner")
        );
        assert!(indexed_filter_field("AssetBalance", 8, 31).is_none());
    }
    fn discriminator(idl: &Value, section: &str, name: &str) -> Vec<u8> {
        idl[section]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["name"] == name)
            .unwrap()["discriminator"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u8)
            .collect()
    }

    #[test]
    fn older_instructions_and_accounts_decode_with_the_idl_that_wrote_them() {
        let current = &idl_versions()[0];
        // create_club before club types: id and name only, four accounts.
        let mut legacy = discriminator(current, "instructions", "create_club");
        legacy.extend([7_u8; 32]);
        legacy.extend(4_u32.to_le_bytes());
        legacy.extend(b"Club");
        let (name, args, roles) = decode_instruction_roles(&legacy, 4).unwrap();
        assert_eq!(name, "create_club");
        assert_eq!(args["name"], "Club");
        assert_eq!(roles, ["owner", "club", "owner_member", "system_program"]);
        // The same instruction today carries the club type and two more accounts.
        let mut typed = legacy.clone();
        typed.push(1);
        let (_, args, roles) = decode_instruction_roles(&typed, 6).unwrap();
        assert_eq!(args["kind"], json!({"public":{}}));
        assert_eq!(roles[1], "club_rules");
        // Too few accounts for every known version is still an error.
        assert!(decode_instruction_roles(&typed, 3).is_err());

        // A join instruction keeps its arguments but gained the rules account:
        // the account count selects the role list.
        let accept = discriminator(current, "instructions", "accept_club_invite");
        assert_eq!(decode_instruction_roles(&accept, 6).unwrap().2.len(), 6);
        assert_eq!(
            decode_instruction_roles(&accept, 7).unwrap().2[2],
            "club_rules"
        );

        // A club not migrated yet still decodes, with its old fields.
        let mut club = discriminator(current, "accounts", "Club");
        club.extend([7_u8; 32]);
        club.extend([1_u8; 32]);
        club.push(0); // no pending owner
        club.extend(4_u32.to_le_bytes());
        club.extend(b"Club");
        club.push(0); // admins-only policy
        club.extend(3_u32.to_le_bytes());
        club.extend(1_u32.to_le_bytes());
        club.extend(9_i64.to_le_bytes());
        club.push(254);
        let (_, old) = decode_account(&club).unwrap();
        assert_eq!(old["memberCount"], 3);
        assert!(old.get("kind").is_none());
        club.push(1);
        club.extend([0_u8; 96]);
        let (_, migrated) = decode_account(&club).unwrap();
        assert_eq!(migrated["kind"], json!({"public":{}}));
    }
}
