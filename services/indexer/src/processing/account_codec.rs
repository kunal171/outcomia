//! Decode the checked-in Anchor IDL without rounding u64 balances or IDs.
use serde_json::{json, Map, Value};
use std::{io, sync::OnceLock};

pub const IDL_BYTES: &str = include_str!("../../../../app/idl/outcomia.json");
pub fn idl() -> &'static Value {
    static IDL: OnceLock<Value> = OnceLock::new();
    IDL.get_or_init(|| serde_json::from_str(IDL_BYTES).expect("checked-in IDL"))
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
fn fields(fields: &[Value], input: &mut &[u8], depth: usize) -> io::Result<Value> {
    if fields.first().is_some_and(|f| f.get("name").is_none()) {
        return fields
            .iter()
            .map(|f| decode(f, input, depth + 1))
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
            decode(&field["type"], input, depth + 1)?,
        );
    }
    Ok(Value::Object(object))
}
pub fn decode(ty: &Value, input: &mut &[u8], depth: usize) -> io::Result<Value> {
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
            1 => decode(inner, input, depth + 1),
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
            .map(|_| decode(inner, input, depth + 1))
            .collect::<io::Result<Vec<_>>>()
            .map(Value::Array);
    }
    if let Some(name) = ty.pointer("/defined/name").and_then(Value::as_str) {
        let definition = idl()["types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .ok_or_else(|| invalid("unknown IDL definition"))?;
        let body = &definition["type"];
        return match body["kind"].as_str() {
            Some("struct") => fields(
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
                    fields(f, input, depth + 1)?
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
    let definition = idl()["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| {
            a["discriminator"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .all(|(i, n)| n.as_u64() == Some(bytes[i] as u64))
        })
        .ok_or_else(|| invalid("unknown account discriminator; check deployed IDL"))?;
    let name = definition["name"].as_str().unwrap();
    let mut input = &bytes[8..];
    let value = decode(&json!({"defined":{"name":name}}), &mut input, 0)?;
    if input.iter().any(|v| *v != 0) {
        return Err(invalid("nonzero trailing account bytes"));
    }
    Ok((name.to_owned(), value))
}

pub fn decode_instruction(bytes: &[u8]) -> io::Result<(String, Value)> {
    if bytes.len() < 8 || bytes.len() > 131072 {
        return Err(invalid("invalid instruction length"));
    }
    let definition = idl()["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| {
            a["discriminator"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .all(|(i, n)| n.as_u64() == Some(bytes[i] as u64))
        })
        .ok_or_else(|| invalid("unknown instruction discriminator"))?;
    let mut body = &bytes[8..];
    let args = fields(definition["args"].as_array().unwrap(), &mut body, 0)?;
    if !body.is_empty() {
        return Err(invalid("trailing instruction bytes"));
    }
    Ok((definition["name"].as_str().unwrap().to_owned(), args))
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
        account.push(1);
        assert!(decode_account(&account).is_err());
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
}
