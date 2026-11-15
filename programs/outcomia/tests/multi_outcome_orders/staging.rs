use super::*;
use outcomia::instructions::multi_outcome_staging::{MultiOutcomeTermsBuffer, MULTI_TERMS_SEED};

#[test]
fn maximum_terms_stage_with_hash_binding_owner_checks_and_rent_recovery() {
    let mut f = Fixture::new();
    let authority = f.admin.pubkey();
    let buffer = pda(MULTI_TERMS_SEED, &[authority.as_ref(), f.id.as_ref()]);
    let mut terms = f.terms(8);
    terms.outcome_labels = (0..8).map(|i| format!("{i}{}", "x".repeat(63))).collect();
    terms.rules_uri = format!("https://{}", "x".repeat(192));
    let mut bytes = Vec::new();
    anchor_lang::AnchorSerialize::serialize(&terms, &mut bytes).unwrap();
    // Clone the market ID rather than retaining a borrow of the mutable fixture.
    let market_id = f.id;
    let write = move |offset: u32, chunk: Vec<u8>| {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::WriteMultiOutcomeTerms {
                market_id,
                offset,
                bytes: chunk,
            }
            .data(),
            outcomia::accounts::WriteMultiOutcomeTerms {
                authority,
                buffer,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    };
    let first = write(0, bytes[..600].to_vec());
    assert!(
        wincode::serialize(&f.transaction(first.clone()))
            .unwrap()
            .len()
            <= 1232
    );
    f.send(first).unwrap();
    let mut foreign = write(600, bytes[600..].to_vec());
    foreign.accounts[0].pubkey = f.attacker.pubkey();
    assert!(f.send(foreign).is_err());
    assert!(f.send(write(599, bytes[600..].to_vec())).is_err());
    for (i, chunk) in bytes.chunks(600).enumerate().skip(1) {
        f.send(write((i * 600) as u32, chunk.to_vec())).unwrap();
    }
    let stored: MultiOutcomeTermsBuffer = f.read(buffer);
    assert_eq!(stored.bytes, bytes);
    let mut create = f.creation(terms.clone());
    create.data = outcomia::instruction::InitializeMultiOutcomeMarketFromStaged {
        market_id,
        terms_hash: [0; 32],
        display_name: "Multi-outcome test".into(),
        collateral_symbol: "USDC".into(),
    }
    .data();
    create
        .accounts
        .push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(buffer, false));
    assert!(f.send(create.clone()).is_err());
    assert!(f.svm.get_account(&f.market_key()).is_none());
    create.data = outcomia::instruction::InitializeMultiOutcomeMarketFromStaged {
        market_id,
        terms_hash: solana_sha256_hasher::hash(&bytes).to_bytes(),
        display_name: "Multi-outcome test".into(),
        collateral_symbol: "USDC".into(),
    }
    .data();
    let size = wincode::serialize(&f.transaction(create.clone()))
        .unwrap()
        .len();
    assert!(size <= 1232);
    let meta = f.send(create).unwrap();
    assert_eq!(f.market().terms, terms);
    println!(
        "MULTI_BUDGET staged-create outcomes=8 bytes={size} compute={}",
        meta.compute_units_consumed
    );
    let close = Instruction::new_with_bytes(
        outcomia::ID,
        &outcomia::instruction::CloseMultiOutcomeTerms {}.data(),
        outcomia::accounts::CloseMultiOutcomeTerms { authority, buffer }.to_account_metas(None),
    );
    let mut foreign = close.clone();
    foreign.accounts[0].pubkey = f.attacker.pubkey();
    assert!(f.send(foreign).is_err());
    f.send(close).unwrap();
    assert!(f.svm.get_account(&buffer).is_none_or(|a| a.lamports == 0));
}
