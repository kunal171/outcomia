//! LiteSVM coverage for optional market labels and immutable classification.

#![allow(clippy::result_large_err)]

mod support;

use {
    anchor_lang::{
        prelude::Pubkey, solana_program::instruction::Instruction, system_program,
        AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    tidebook::state::{AdminRecord, AdminStatus, Market, MarketKind, MarketMetadata, MarketStatus},
};

const PROGRAM_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/tidebook.so"
));

struct Fixture {
    svm: LiteSVM,
    admin: Keypair,
    market: Pubkey,
}

fn store_program_account<T: AccountSerialize>(svm: &mut LiteSVM, address: Pubkey, state: &T) {
    let mut data = Vec::new();
    state.try_serialize(&mut data).unwrap();
    svm.set_account(
        address,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: tidebook::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn admin_record_address(authority: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[tidebook::constants::ADMIN_SEED, authority.as_ref()],
        &tidebook::id(),
    )
    .0
}

fn store_admin(svm: &mut LiteSVM, authority: Pubkey, status: AdminStatus) {
    let (address, bump) = Pubkey::find_program_address(
        &[tidebook::constants::ADMIN_SEED, authority.as_ref()],
        &tidebook::id(),
    );
    store_program_account(
        svm,
        address,
        &AdminRecord {
            authority,
            added_by: authority,
            status,
            bump,
        },
    );
}

fn store_market(svm: &mut LiteSVM, authority: Pubkey) -> Pubkey {
    let market = Pubkey::new_unique();
    store_program_account(
        svm,
        market,
        &Market {
            authority,
            base_mint: Pubkey::new_unique(),
            quote_mint: Pubkey::new_unique(),
            status: MarketStatus::Active,
            next_order_id: 1,
            base_decimals: 9,
            quote_decimals: 6,
            price_tick_size: 10_000,
            quantity_lot_size: 100_000,
            best_bid: None,
            best_ask: None,
            open_order_count: 0,
            bump: 0,
        },
    );
    market
}

fn setup(status: AdminStatus) -> Fixture {
    let mut svm = LiteSVM::new();
    let admin = Keypair::new();
    svm.add_program(tidebook::id(), PROGRAM_BYTES).unwrap();
    svm.airdrop(&admin.pubkey(), 2_000_000_000).unwrap();
    store_admin(&mut svm, admin.pubkey(), status);
    let market = store_market(&mut svm, admin.pubkey());

    Fixture { svm, admin, market }
}

fn send_instruction(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instruction: Instruction,
) -> litesvm::types::TransactionResult {
    svm.expire_blockhash();
    let message = Message::new_with_blockhash(
        &[instruction],
        Some(&payer.pubkey()),
        &svm.latest_blockhash(),
    );
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), &[payer]).unwrap();
    svm.send_transaction(transaction)
}

fn initialize_instruction(
    authority: Pubkey,
    market: Pubkey,
    base_symbol: &str,
    quote_symbol: &str,
    display_name: &str,
    kind: MarketKind,
) -> (Pubkey, Instruction) {
    let (market_metadata, _) = tidebook::derive_market_metadata_pda(&tidebook::id(), &market);
    let instruction = Instruction::new_with_bytes(
        tidebook::id(),
        &tidebook::instruction::InitializeMarketMetadata {
            base_symbol: base_symbol.to_owned(),
            quote_symbol: quote_symbol.to_owned(),
            display_name: display_name.to_owned(),
            kind,
        }
        .data(),
        tidebook::accounts::InitializeMarketMetadata {
            authority,
            admin_record: admin_record_address(&authority),
            market,
            market_metadata,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    (market_metadata, instruction)
}

fn update_instruction(
    authority: Pubkey,
    market: Pubkey,
    market_metadata: Pubkey,
    base_symbol: &str,
    quote_symbol: &str,
    display_name: &str,
) -> Instruction {
    Instruction::new_with_bytes(
        tidebook::id(),
        &tidebook::instruction::UpdateMarketMetadata {
            base_symbol: base_symbol.to_owned(),
            quote_symbol: quote_symbol.to_owned(),
            display_name: display_name.to_owned(),
        }
        .data(),
        tidebook::accounts::UpdateMarketMetadata {
            authority,
            admin_record: admin_record_address(&authority),
            market,
            market_metadata,
        }
        .to_account_metas(None),
    )
}

fn close_instruction(authority: Pubkey, market: Pubkey, market_metadata: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        tidebook::id(),
        &tidebook::instruction::CloseMarketMetadata {}.data(),
        tidebook::accounts::CloseMarketMetadata {
            authority,
            market,
            market_metadata,
        }
        .to_account_metas(None),
    )
}

fn load_metadata(svm: &LiteSVM, address: Pubkey) -> MarketMetadata {
    let account = svm.get_account(&address).unwrap();
    MarketMetadata::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn set_market_status(svm: &mut LiteSVM, address: Pubkey, status: MarketStatus) {
    let account = svm.get_account(&address).unwrap();
    let mut market = Market::try_deserialize(&mut account.data.as_slice()).unwrap();
    market.status = status;
    store_program_account(svm, address, &market);
}

#[test]
fn active_admin_initializes_spot_metadata() {
    let mut fixture = setup(AdminStatus::Active);
    let (metadata_address, instruction) = initialize_instruction(
        fixture.admin.pubkey(),
        fixture.market,
        "tSOL",
        "tUSDC",
        "Tidebook SOL / USDC",
        MarketKind::Spot,
    );

    let result = send_instruction(&mut fixture.svm, &fixture.admin, instruction);
    assert!(result.is_ok(), "metadata initialization failed: {result:?}");

    let metadata = load_metadata(&fixture.svm, metadata_address);
    assert_eq!(metadata.market, fixture.market);
    assert_eq!(metadata.base_symbol, "tSOL");
    assert_eq!(metadata.quote_symbol, "tUSDC");
    assert_eq!(metadata.display_name, "Tidebook SOL / USDC");
    assert_eq!(metadata.kind, MarketKind::Spot);
    assert_eq!(
        metadata.bump,
        tidebook::derive_market_metadata_pda(&tidebook::id(), &fixture.market).1
    );

    let event =
        support::events::single_event::<tidebook::events::MarketMetadataInitializedEvent>(&result);
    assert_eq!(event.metadata, metadata_address);
    assert_eq!(event.market, fixture.market);
    assert_eq!(event.authority, fixture.admin.pubkey());
    assert_eq!(event.kind, MarketKind::Spot);
}

#[test]
fn active_admin_updates_labels_without_changing_kind() {
    let mut fixture = setup(AdminStatus::Active);
    let (metadata_address, initialize) = initialize_instruction(
        fixture.admin.pubkey(),
        fixture.market,
        "SOL",
        "USDC",
        "SOL market",
        MarketKind::Other,
    );
    assert!(send_instruction(&mut fixture.svm, &fixture.admin, initialize).is_ok());

    let update = update_instruction(
        fixture.admin.pubkey(),
        fixture.market,
        metadata_address,
        "tSOL",
        "tUSD",
        "Updated display name",
    );
    let result = send_instruction(&mut fixture.svm, &fixture.admin, update);
    assert!(result.is_ok(), "metadata update failed: {result:?}");

    let metadata = load_metadata(&fixture.svm, metadata_address);
    assert_eq!(metadata.base_symbol, "tSOL");
    assert_eq!(metadata.quote_symbol, "tUSD");
    assert_eq!(metadata.display_name, "Updated display name");
    assert_eq!(metadata.kind, MarketKind::Other);

    let event =
        support::events::single_event::<tidebook::events::MarketMetadataUpdatedEvent>(&result);
    assert_eq!(event.metadata, metadata_address);
    assert_eq!(event.display_name, "Updated display name");
}

#[test]
fn prediction_metadata_is_rejected_until_settlement_exists() {
    let mut fixture = setup(AdminStatus::Active);
    let (metadata_address, instruction) = initialize_instruction(
        fixture.admin.pubkey(),
        fixture.market,
        "YES",
        "USDC",
        "Will this market resolve yes?",
        MarketKind::Prediction,
    );

    let result = send_instruction(&mut fixture.svm, &fixture.admin, instruction);
    assert!(result.is_err(), "prediction metadata was initialized");
    assert!(fixture.svm.get_account(&metadata_address).is_none());
}

#[test]
fn disabled_or_missing_admin_cannot_manage_metadata() {
    let mut disabled = setup(AdminStatus::Disabled);
    let (disabled_metadata, instruction) = initialize_instruction(
        disabled.admin.pubkey(),
        disabled.market,
        "SOL",
        "USDC",
        "SOL / USDC",
        MarketKind::Spot,
    );
    assert!(send_instruction(&mut disabled.svm, &disabled.admin, instruction).is_err());
    assert!(disabled.svm.get_account(&disabled_metadata).is_none());

    let mut missing = LiteSVM::new();
    let outsider = Keypair::new();
    missing.add_program(tidebook::id(), PROGRAM_BYTES).unwrap();
    missing.airdrop(&outsider.pubkey(), 2_000_000_000).unwrap();
    let market = store_market(&mut missing, outsider.pubkey());
    let (missing_metadata, instruction) = initialize_instruction(
        outsider.pubkey(),
        market,
        "SOL",
        "USDC",
        "SOL / USDC",
        MarketKind::Spot,
    );
    assert!(send_instruction(&mut missing, &outsider, instruction).is_err());
    assert!(missing.get_account(&missing_metadata).is_none());
}

#[test]
fn invalid_labels_and_duplicate_initialization_are_rejected() {
    for (base, quote, name) in [
        ("SOL/USDC", "USDC", "SOL / USDC"),
        ("SOL", "", "SOL / USDC"),
        ("SOL", "USDC", " outer whitespace "),
        ("SOL", "USDC", "line\nbreak"),
    ] {
        let mut fixture = setup(AdminStatus::Active);
        let (metadata_address, instruction) = initialize_instruction(
            fixture.admin.pubkey(),
            fixture.market,
            base,
            quote,
            name,
            MarketKind::Spot,
        );
        assert!(send_instruction(&mut fixture.svm, &fixture.admin, instruction).is_err());
        assert!(fixture.svm.get_account(&metadata_address).is_none());
    }

    let mut fixture = setup(AdminStatus::Active);
    let (metadata_address, first) = initialize_instruction(
        fixture.admin.pubkey(),
        fixture.market,
        "SOL",
        "USDC",
        "SOL / USDC",
        MarketKind::Spot,
    );
    assert!(send_instruction(&mut fixture.svm, &fixture.admin, first).is_ok());
    let (_, second) = initialize_instruction(
        fixture.admin.pubkey(),
        fixture.market,
        "SOL",
        "USDC",
        "Duplicate",
        MarketKind::Spot,
    );
    assert!(send_instruction(&mut fixture.svm, &fixture.admin, second).is_err());
    assert_eq!(
        load_metadata(&fixture.svm, metadata_address).display_name,
        "SOL / USDC"
    );
}

#[test]
fn metadata_cannot_be_updated_through_another_market() {
    let mut fixture = setup(AdminStatus::Active);
    let (metadata_address, initialize) = initialize_instruction(
        fixture.admin.pubkey(),
        fixture.market,
        "SOL",
        "USDC",
        "SOL / USDC",
        MarketKind::Spot,
    );
    assert!(send_instruction(&mut fixture.svm, &fixture.admin, initialize).is_ok());

    let other_market = store_market(&mut fixture.svm, fixture.admin.pubkey());
    let update = update_instruction(
        fixture.admin.pubkey(),
        other_market,
        metadata_address,
        "BAD",
        "PAIR",
        "Wrong market",
    );
    assert!(send_instruction(&mut fixture.svm, &fixture.admin, update).is_err());
    assert_eq!(
        load_metadata(&fixture.svm, metadata_address).display_name,
        "SOL / USDC"
    );
}

#[test]
fn market_authority_closes_metadata_only_while_market_is_paused() {
    let mut fixture = setup(AdminStatus::Active);
    let (metadata_address, initialize) = initialize_instruction(
        fixture.admin.pubkey(),
        fixture.market,
        "SOL",
        "USDC",
        "SOL / USDC",
        MarketKind::Spot,
    );
    assert!(send_instruction(&mut fixture.svm, &fixture.admin, initialize).is_ok());

    let close = close_instruction(fixture.admin.pubkey(), fixture.market, metadata_address);
    assert!(
        send_instruction(&mut fixture.svm, &fixture.admin, close).is_err(),
        "active market metadata was closed"
    );
    assert!(fixture.svm.get_account(&metadata_address).is_some());

    set_market_status(&mut fixture.svm, fixture.market, MarketStatus::Paused);
    let close = close_instruction(fixture.admin.pubkey(), fixture.market, metadata_address);
    let result = send_instruction(&mut fixture.svm, &fixture.admin, close);
    assert!(result.is_ok(), "metadata closure failed: {result:?}");
    assert!(fixture.svm.get_account(&metadata_address).is_none());

    let event =
        support::events::single_event::<tidebook::events::MarketMetadataClosedEvent>(&result);
    assert_eq!(event.metadata, metadata_address);
    assert_eq!(event.market, fixture.market);
    assert_eq!(event.authority, fixture.admin.pubkey());
    assert_eq!(event.kind, MarketKind::Spot);
}
