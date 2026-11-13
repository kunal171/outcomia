//! # Multi-Outcome Prediction Markets: Order Book & Settlement Integration Tests
//!
//! This integration test suite exercises the complete lifecycle of Outcomia's multi-outcome
//! prediction markets (2 to 8 distinct mutually exclusive outcomes) under simulated Solana
//! SBF execution via LiteSVM:
//!
//! 1. **Order Book Initialization (`InitializeMultiOutcomeBook`)**:
//!    - Authority and role-based access control (RBAC): only the active-admin creator can initialize.
//!    - State transition: creates the root `MultiOutcomeBook` account with sequence counter `next_order_id = 1`.
//!    - Defense-in-depth: rejects non-admin, disabled admin, unauthorized caller, and duplicate initializations.
//!
//! 2. **Resting Order Placement (`PlaceMultiOutcomeOrder`)**:
//!    - Escrow & Collateral Locking:
//!      - **Bid**: locks `price * quantity` collateral atoms from the trader's shared `AssetBalance.free` into `locked`.
//!      - **Ask**: locks `quantity` outcome contracts from the trader's `MultiOutcomePosition.free[outcome]` into `locked[outcome]`.
//!    - Book Queue Management: appends order reference `(order_pubkey, order_id, outcome, side, price)` to the book vector.
//!    - Grid & Spread Validation:
//!      - Rejects orders crossing existing opposite-side best prices (resting placements must not cross).
//!      - Enforces exact price ticks (`price % price_tick == 0`) and quantity lots (`quantity % quantity_lot == 0`).
//!      - Enforces price cap (`price < payout_per_contract`) and strict sequence matching (`order_id == next_order_id`).
//!
//! 3. **Owner Cancellation (`CancelMultiOutcomeOrder`)**:
//!    - Escrow Refund: returns locked collateral atoms (for Bids) or locked outcome contracts (for Asks) back to `free`.
//!    - Book Repair: removes order reference from `book.orders` and marks account status as `OrderStatus::Canceled`.
//!    - Access Control & Timing: rejects non-owner cancellation and cancellation replays.
//!    - Lifecycle Invariant: cancellation remains permissionless and available even after trading cutoff, freeze, and final resolution.
//!
//! 4. **Best-Price FIFO Matching (`MatchMultiOutcomeOrder`)**:
//!    - Execution Price: executed at resting **maker** price, protecting makers and rewarding price improvement.
//!    - Priority Enforcement: rejects matches if maker is not at best price, or not at the FIFO head for that price.
//!    - Fee Accounting: calculates quote-denominated protocol taker fee in basis points; maker pays 0 maker fee.
//!    - Settlement:
//!      - **Bid Taker**: taker pays `(cost + fee)` from cash; maker receives `cost` in cash; contracts transfer from maker locked to taker free.
//!      - **Ask Taker**: taker provides contracts; receives `(cost - fee)` net proceeds; maker cash locked is debited; maker receives contracts.
//!    - Partial Fills: remaining maker quantity is decremented; order remains `Open` with partial locked escrow.
//!    - Full Fills: maker order transitions to `OrderStatus::Filled` and is pruned from `book.orders`.
//!
//! 5. **Protocol Fee Withdrawal (`WithdrawMultiOutcomeFees`)**:
//!    - Transfers accumulated trading fees from the global asset vault to a super-admin token account via SPL transfer.
//!    - Rejects non-super-admin callers and withdrawals exceeding accrued fees.
//!
//! 6. **Outcome Resolution & Redemption Lifecycle**:
//!    - **Proposal (`ProposeMultiOutcome`)**: primary resolver publishes outcome with IPFS/Arweave URI and SHA-256 evidence hash.
//!    - **Delay & Finalization (`AdvanceMultiOutcome`)**:
//!      - Action 0: freezes market at cutoff timestamp.
//!      - Action 2: finalizes proposed outcome after resolution review delay matures.
//!      - Action 3: falls back to `Invalid` outcome if resolver timeout expires.
//!    - **Winning Outcome Redemption (`RedeemMultiOutcome`)**:
//!      - Winning outcome contracts redeem 1:1 for face payout `P` collateral atoms.
//!      - Losing outcome contracts burn for 0 payout without failing or draining the vault.
//!    - **Invalid Outcome Redemption (`RedeemMultiOutcome`)**:
//!      - Strictly enforces `(L * P) % N == 0` so each outcome contract yields exact equal refund `(L * P) / N` with zero dust loss.
#![allow(clippy::result_large_err, clippy::too_many_arguments)]
use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack, system_program},
    AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token::state::{Account as TokenAccount, AccountState, Mint};
use litesvm::{types::TransactionResult, LiteSVM};
use outcomia::{constants::*, state::*};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
mod support;
use support::events::single_event;

/// Compiled SBF bytecode of the `outcomia` Anchor program loaded into LiteSVM.
const PROGRAM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/outcomia.so"
));

/// Canonical program-derived address (PDA) derivation helper for test fixtures.
fn pda(seed: &[u8], parts: &[&[u8]]) -> Pubkey {
    let mut seeds = vec![seed];
    seeds.extend_from_slice(parts);
    Pubkey::find_program_address(&seeds, &outcomia::ID).0
}

/// Serializes and stores an Anchor account directly into the LiteSVM state database.
fn store<T: AccountSerialize>(svm: &mut LiteSVM, key: Pubkey, value: &T) {
    let mut data = Vec::new();
    value
        .try_serialize(&mut data)
        .expect("fixture serialization");
    if let Some(old) = svm.get_account(&key) {
        data.resize(old.data.len().max(data.len()), 0);
    }
    svm.set_account(
        key,
        Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: outcomia::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .expect("store state");
}

/// Complete test fixture containing the in-process LiteSVM runtime, participant keypairs,
/// mint configurations, and helper methods for building and executing multi-outcome instructions.
struct Fixture {
    /// In-process Solana virtual machine.
    svm: LiteSVM,
    /// Protocol super-admin and primary market creator/resolver.
    admin: Keypair,
    /// Distinct secondary administrator for fallback resolution windows.
    fallback_admin: Keypair,
    /// Standard trader/maker wallet.
    owner: Keypair,
    /// Counterparty trader/taker wallet.
    taker: Keypair,
    /// Malicious/unauthorized keypair used to test rejection of unauthorized instructions.
    attacker: Keypair,
    /// SPL collateral mint address (e.g. tUSDC with 6 decimals).
    mint: Pubkey,
    /// SPL token account holding collateral for `owner`.
    wallet_owner: Pubkey,
    /// SPL token account holding collateral for `taker`.
    wallet_taker: Pubkey,
    /// SPL token account holding collateral for `admin`.
    wallet_admin: Pubkey,
    /// Unique 32-byte market identifier.
    id: [u8; 32],
}

impl Fixture {
    /// Initializes a fresh test fixture with funded keypairs, deployed program bytecode,
    /// initialized SPL mint and token accounts, active admin records, and singleton protocol config.
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM).expect("program");
        let admin = Keypair::new();
        let fallback_admin = Keypair::new();
        let owner = Keypair::new();
        let taker = Keypair::new();
        let attacker = Keypair::new();

        // Airdrop SOL to cover rent exemption and transaction fees
        for party in [&admin, &fallback_admin, &owner, &taker, &attacker] {
            svm.airdrop(&party.pubkey(), 5_000_000_000).expect("rent");
        }

        // Initialize chain clock at unix timestamp 100
        let mut clock = svm.get_sysvar::<Clock>();
        clock.unix_timestamp = 100;
        svm.set_sysvar(&clock);

        // Initialize SPL collateral mint with 6 decimals (1 token = 1_000_000 atoms)
        let mint = Pubkey::new_unique();
        let mut data = vec![0; Mint::LEN];
        Mint::pack(
            Mint {
                mint_authority: Some(admin.pubkey()).into(),
                supply: 1_000_000_000,
                decimals: 6,
                is_initialized: true,
                freeze_authority: Some(admin.pubkey()).into(),
            },
            &mut data,
        )
        .expect("mint");
        svm.set_account(
            mint,
            Account {
                lamports: svm.minimum_balance_for_rent_exemption(data.len()),
                data,
                owner: anchor_spl::token::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("store mint");

        // Helper to construct and fund an SPL token account for a given owner
        let make_wallet = |svm: &mut LiteSVM, owner_key: Pubkey, initial_amount: u64| -> Pubkey {
            let wallet = Pubkey::new_unique();
            let mut data = vec![0; TokenAccount::LEN];
            TokenAccount::pack(
                TokenAccount {
                    mint,
                    owner: owner_key,
                    amount: initial_amount,
                    delegate: None.into(),
                    state: AccountState::Initialized,
                    is_native: None.into(),
                    delegated_amount: 0,
                    close_authority: None.into(),
                },
                &mut data,
            )
            .expect("pack token account");
            svm.set_account(
                wallet,
                Account {
                    lamports: svm.minimum_balance_for_rent_exemption(data.len()),
                    data,
                    owner: anchor_spl::token::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("store token account");
            wallet
        };

        // Pre-fund wallets with collateral atoms
        let wallet_owner = make_wallet(&mut svm, owner.pubkey(), 100_000_000);
        let wallet_taker = make_wallet(&mut svm, taker.pubkey(), 100_000_000);
        let wallet_admin = make_wallet(&mut svm, admin.pubkey(), 0);

        let mut f = Self {
            svm,
            admin,
            fallback_admin,
            owner,
            taker,
            attacker,
            mint,
            wallet_owner,
            wallet_taker,
            wallet_admin,
            id: [42; 32],
        };

        // Set up active admin authority and 100 bps (1%) protocol taker fee
        f.admin_status(AdminStatus::Active);
        f.set_protocol_fee(100);
        f
    }

    /// Canonical multi-outcome market PDA: `["multi_market", market_id]`.
    fn market_key(&self) -> Pubkey {
        pda(MULTI_OUTCOME_MARKET_SEED, &[&self.id])
    }

    /// Canonical multi-outcome position PDA: `["multi_position", market, owner]`.
    fn position_key(&self, user: &Pubkey) -> Pubkey {
        pda(
            MULTI_OUTCOME_POSITION_SEED,
            &[self.market_key().as_ref(), user.as_ref()],
        )
    }

    /// Shared custody asset balance PDA: `["asset_balance", user, mint]`.
    fn balance_key(&self, user: &Pubkey) -> Pubkey {
        pda(ASSET_BALANCE_SEED, &[user.as_ref(), self.mint.as_ref()])
    }

    /// Canonical multi-outcome order book root PDA: `["multi_book", market]`.
    fn book_key(&self) -> Pubkey {
        pda(MULTI_OUTCOME_BOOK_SEED, &[self.market_key().as_ref()])
    }

    /// Canonical resting order PDA: `["multi_order", book, order_id_le]`.
    fn order_key(&self, order_id: u64) -> Pubkey {
        pda(
            MULTI_OUTCOME_ORDER_SEED,
            &[self.book_key().as_ref(), &order_id.to_le_bytes()],
        )
    }

    /// Canonical market reserve vault PDA: `["vault", market, mint]`.
    fn reserve(&self) -> Pubkey {
        pda(
            VAULT_SEED,
            &[self.market_key().as_ref(), self.mint.as_ref()],
        )
    }

    /// Global shared asset vault PDA: `["asset_vault", mint]`.
    fn global(&self) -> Pubkey {
        pda(ASSET_VAULT_SEED, &[self.mint.as_ref()])
    }

    /// Market metadata PDA: `["market_metadata", market]`.
    fn metadata(&self) -> Pubkey {
        pda(MARKET_METADATA_SEED, &[self.market_key().as_ref()])
    }

    /// Singleton protocol configuration PDA: `["protocol_config"]`.
    fn config_key(&self) -> Pubkey {
        pda(PROTOCOL_CONFIG_SEED, &[])
    }

    /// Updates the administrator record status (Active or Disabled) for `self.admin`.
    fn admin_status(&mut self, status: AdminStatus) {
        let key = pda(ADMIN_SEED, &[self.admin.pubkey().as_ref()]);
        let bump = Pubkey::find_program_address(
            &[ADMIN_SEED, self.admin.pubkey().as_ref()],
            &outcomia::ID,
        )
        .1;
        store(
            &mut self.svm,
            key,
            &AdminRecord {
                authority: self.admin.pubkey(),
                added_by: self.admin.pubkey(),
                status,
                bump,
            },
        );
    }

    /// Sets the protocol-wide taker fee in basis points (e.g. 100 = 1.00%).
    fn set_protocol_fee(&mut self, taker_fee_bps: u16) {
        let (key, bump) = Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &outcomia::ID);
        store(
            &mut self.svm,
            key,
            &ProtocolConfig {
                super_admin: self.admin.pubkey(),
                taker_fee_bps,
                bump,
            },
        );
    }

    /// Generates standard immutable economic terms for an `N`-outcome prediction market:
    /// - Payout per contract: 1_000_000 atoms (1 full collateral token).
    /// - Price tick: 10_000 atoms (0.01 tokens).
    /// - Quantity lot size: `count` (ensures `(quantity_lot * payout) % count == 0` for exact Invalid refunds).
    /// - Close timestamp: 200; Fallback window: 250..300.
    fn terms(&self, count: u8) -> MultiOutcomeTerms {
        MultiOutcomeTerms {
            resolver: self.admin.pubkey(),
            fallback: Some(PredictionFallback {
                resolver: self.fallback_admin.pubkey(),
                available_ts: 250,
                deadline_ts: Some(300),
            }),
            outcome_labels: (0..count).map(|i| format!("Candidate {i}")).collect(),
            question_hash: [1; 32],
            rules_hash: [2; 32],
            rules_uri: "ar://rules".into(),
            close_ts: 200,
            earliest_resolution_ts: Some(200),
            resolution_delay_seconds: 10,
            payout_per_contract: 1_000_000,
            price_tick: 10_000,
            quantity_lot: u64::from(count),
        }
    }

    /// Builds the `InitializeMultiOutcomeMarket` instruction.
    fn creation(&self, terms: MultiOutcomeTerms) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::InitializeMultiOutcomeMarket {
                market_id: self.id,
                terms,
                display_name: "Which candidate wins?".into(),
                collateral_symbol: "tUSDC".into(),
            }
            .data(),
            outcomia::accounts::InitializeMultiOutcomeMarket {
                authority: self.admin.pubkey(),
                admin_record: pda(ADMIN_SEED, &[self.admin.pubkey().as_ref()]),
                market: self.market_key(),
                collateral_mint: self.mint,
                vault_authority: pda(VAULT_AUTHORITY_SEED, &[self.market_key().as_ref()]),
                collateral_vault: self.reserve(),
                market_metadata: self.metadata(),
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Builds the `OpenMultiOutcomeMarket` or `CloseMultiOutcomeTrading` instruction.
    fn manage(&self, open: bool) -> Instruction {
        let data = if open {
            outcomia::instruction::OpenMultiOutcomeMarket {}.data()
        } else {
            outcomia::instruction::CloseMultiOutcomeTrading {}.data()
        };
        Instruction::new_with_bytes(
            outcomia::ID,
            &data,
            outcomia::accounts::ManageMultiOutcomeMarket {
                authority: self.admin.pubkey(),
                market: self.market_key(),
                admin_record: pda(ADMIN_SEED, &[self.admin.pubkey().as_ref()]),
            }
            .to_account_metas(None),
        )
    }

    /// Builds the `InitializeMultiOutcomePosition` instruction for a trader wallet.
    fn position_init(&self, user: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::InitializeMultiOutcomePosition {}.data(),
            outcomia::accounts::InitializeMultiOutcomePosition {
                owner: *user,
                market: self.market_key(),
                position: self.position_key(user),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Builds the `InitializeAssetBalance` instruction for shared custody asset tracking.
    fn balance_init(&self, user: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::InitializeAssetBalance {}.data(),
            outcomia::accounts::InitializeAssetBalance {
                owner: *user,
                mint: self.mint,
                asset_balance: self.balance_key(user),
                vault_authority: pda(ASSET_AUTHORITY_SEED, &[self.mint.as_ref()]),
                asset_vault: self.global(),
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Builds the `DepositAsset` or `WithdrawAsset` instruction to move collateral between
    /// an external wallet token account and the internal shared `AssetBalance`.
    fn asset_transfer(
        &self,
        user: &Pubkey,
        wallet: Pubkey,
        amount: u64,
        withdraw: bool,
    ) -> Instruction {
        let data = if withdraw {
            outcomia::instruction::WithdrawAsset { amount }.data()
        } else {
            outcomia::instruction::DepositAsset { amount }.data()
        };
        Instruction::new_with_bytes(
            outcomia::ID,
            &data,
            outcomia::accounts::TransferAsset {
                owner: *user,
                mint: self.mint,
                asset_balance: self.balance_key(user),
                wallet_token: wallet,
                vault_authority: pda(ASSET_AUTHORITY_SEED, &[self.mint.as_ref()]),
                asset_vault: self.global(),
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Builds the `MultiOutcomeCompleteSet` instruction:
    /// - `split = true`: locks `q * payout` collateral and mints `q` of all `N` outcome tokens.
    /// - `split = false`: burns `q` of all `N` outcome tokens and refunds `q * payout` collateral.
    fn complete(&self, user: &Pubkey, q: u64, split: bool) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::MultiOutcomeCompleteSet { quantity: q, split }.data(),
            outcomia::accounts::MultiOutcomeCustody {
                owner: *user,
                market: self.market_key(),
                position: self.position_key(user),
                mint: self.mint,
                asset_balance: self.balance_key(user),
                asset_authority: pda(ASSET_AUTHORITY_SEED, &[self.mint.as_ref()]),
                asset_vault: self.global(),
                market_authority: pda(VAULT_AUTHORITY_SEED, &[self.market_key().as_ref()]),
                market_vault: self.reserve(),
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Builds the `InitializeMultiOutcomeBook` instruction to initialize the market's resting order book.
    fn init_book(&self, authority: &Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::InitializeMultiOutcomeBook {}.data(),
            outcomia::accounts::InitializeMultiOutcomeBook {
                authority: *authority,
                admin_record: pda(ADMIN_SEED, &[authority.as_ref()]),
                market: self.market_key(),
                book: self.book_key(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Builds the `PlaceMultiOutcomeOrder` instruction to place a resting Bid or Ask order.
    fn place_order(
        &self,
        user: &Pubkey,
        outcome: OutcomeId,
        side: OrderSide,
        price: u64,
        quantity: u64,
        order_id: u64,
    ) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::PlaceMultiOutcomeOrder {
                outcome,
                side,
                price,
                quantity,
                order_id,
            }
            .data(),
            outcomia::accounts::PlaceMultiOutcomeOrder {
                owner: *user,
                market: self.market_key(),
                book: self.book_key(),
                cash: self.balance_key(user),
                position: self.position_key(user),
                order: self.order_key(order_id),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Builds the `CancelMultiOutcomeOrder` instruction to cancel an existing resting order.
    fn cancel_order(&self, user: &Pubkey, order_id: u64) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::CancelMultiOutcomeOrder {}.data(),
            outcomia::accounts::CancelMultiOutcomeOrder {
                owner: *user,
                market: self.market_key(),
                book: self.book_key(),
                order: self.order_key(order_id),
                cash: self.balance_key(user),
                position: self.position_key(user),
            }
            .to_account_metas(None),
        )
    }

    /// Builds the `MatchMultiOutcomeOrder` instruction for an atomic FIFO match against resting maker.
    fn match_order(
        &self,
        taker: &Pubkey,
        maker: &Pubkey,
        maker_order_id: u64,
        outcome: OutcomeId,
        taker_side: OrderSide,
        limit_price: u64,
        quantity: u64,
        expected_fee_bps: u16,
    ) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::MatchMultiOutcomeOrder {
                outcome,
                taker_side,
                limit_price,
                quantity,
                expected_fee_bps,
            }
            .data(),
            outcomia::accounts::MatchMultiOutcomeOrder {
                taker: *taker,
                market: self.market_key(),
                book: self.book_key(),
                protocol_config: self.config_key(),
                maker_order: self.order_key(maker_order_id),
                maker_cash: self.balance_key(maker),
                maker_position: self.position_key(maker),
                taker_cash: self.balance_key(taker),
                taker_position: self.position_key(taker),
            }
            .to_account_metas(None),
        )
    }

    /// Builds the `WithdrawMultiOutcomeFees` instruction for super-admin fee withdrawal.
    fn withdraw_fees(&self, amount: u64) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::WithdrawMultiOutcomeFees { amount }.data(),
            outcomia::accounts::WithdrawMultiOutcomeFees {
                super_admin: self.admin.pubkey(),
                protocol_config: self.config_key(),
                market: self.market_key(),
                book: self.book_key(),
                mint: self.mint,
                destination: self.wallet_admin,
                vault_authority: pda(ASSET_AUTHORITY_SEED, &[self.mint.as_ref()]),
                asset_vault: self.global(),
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Builds the `ProposeMultiOutcome` instruction to submit a resolver outcome proposal.
    fn propose(
        &self,
        resolver: &Pubkey,
        outcome: MultiOutcomeResolution,
        evidence_uri: String,
        evidence_hash: [u8; 32],
        correction: bool,
    ) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::ProposeMultiOutcome {
                outcome,
                evidence_uri,
                evidence_hash,
                correction,
            }
            .data(),
            outcomia::accounts::ResolveMultiOutcome {
                resolver: *resolver,
                market: self.market_key(),
                admin_record: pda(ADMIN_SEED, &[resolver.as_ref()]),
            }
            .to_account_metas(None),
        )
    }

    /// Builds the `AdvanceMultiOutcome` instruction for clock/phase advancement:
    /// - 0: Freeze trading at cutoff timestamp.
    /// - 1: Activate fallback resolver window.
    /// - 2: Finalize mature proposal after review delay.
    /// - 3: Finalize Invalid timeout when fallback deadline passes.
    fn advance(&self, action: u8) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::AdvanceMultiOutcome { action }.data(),
            outcomia::accounts::AdvanceMultiOutcome {
                market: self.market_key(),
            }
            .to_account_metas(None),
        )
    }

    /// Builds the `RedeemMultiOutcome` instruction to burn winning or Invalid contracts for collateral.
    fn redeem(&self, user: &Pubkey, quantities: [u64; 8]) -> Instruction {
        Instruction::new_with_bytes(
            outcomia::ID,
            &outcomia::instruction::RedeemMultiOutcome { quantities }.data(),
            outcomia::accounts::MultiOutcomeCustody {
                owner: *user,
                market: self.market_key(),
                position: self.position_key(user),
                mint: self.mint,
                asset_balance: self.balance_key(user),
                asset_authority: pda(ASSET_AUTHORITY_SEED, &[self.mint.as_ref()]),
                asset_vault: self.global(),
                market_authority: pda(VAULT_AUTHORITY_SEED, &[self.market_key().as_ref()]),
                market_vault: self.reserve(),
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Constructs and signs a VersionedTransaction matching the instruction's signer requirements.
    fn transaction(&self, ix: Instruction) -> VersionedTransaction {
        let payer = if let Some(first_signer) = ix.accounts.iter().find(|m| m.is_signer) {
            first_signer.pubkey
        } else {
            self.admin.pubkey()
        };
        let msg = Message::new_with_blockhash(&[ix], Some(&payer), &self.svm.latest_blockhash());
        let keys = &msg.account_keys[..usize::from(msg.header.num_required_signatures)];
        let signers: Vec<_> = [
            &self.admin,
            &self.fallback_admin,
            &self.owner,
            &self.taker,
            &self.attacker,
        ]
        .into_iter()
        .filter(|s| keys.contains(&s.pubkey()))
        .collect();
        VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers).expect("sign")
    }

    /// Dispatches an instruction to LiteSVM with a refreshed blockhash.
    fn send(&mut self, ix: Instruction) -> TransactionResult {
        self.svm.expire_blockhash();
        let tx = self.transaction(ix);
        self.svm.send_transaction(tx)
    }

    /// Deserializes an on-chain account from LiteSVM by its public key.
    fn read<T: AccountDeserialize>(&self, key: Pubkey) -> T {
        T::try_deserialize(&mut self.svm.get_account(&key).expect("account").data.as_slice())
            .expect("decode")
    }

    /// Reads the current state of the market account.
    fn market(&self) -> MultiOutcomeMarket {
        self.read(self.market_key())
    }

    /// Reads the current state of the order book account.
    fn book(&self) -> MultiOutcomeBook {
        self.read(self.book_key())
    }

    /// Reads the current state of a resting order account.
    fn order(&self, order_id: u64) -> MultiOutcomeOrder {
        self.read(self.order_key(order_id))
    }

    /// Reads the current state of a trader's multi-outcome position account.
    fn position(&self, user: &Pubkey) -> MultiOutcomePosition {
        self.read(self.position_key(user))
    }

    /// Reads the current state of a trader's shared custody asset balance account.
    fn balance(&self, user: &Pubkey) -> AssetBalance {
        self.read(self.balance_key(user))
    }

    /// Unpacks the balance of an SPL token account.
    fn tokens(&self, key: Pubkey) -> u64 {
        TokenAccount::unpack(&self.svm.get_account(&key).expect("token").data)
            .expect("unpack")
            .amount
    }

    /// Standard bootstrap helper: initializes market, initializes book, opens market,
    /// initializes position and balance accounts for `owner` and `taker`, and deposits 20 tokens each.
    fn setup_active_market(&mut self, count: u8) {
        let admin_key = self.admin.pubkey();
        let owner_key = self.owner.pubkey();
        let taker_key = self.taker.pubkey();
        let wallet_owner = self.wallet_owner;
        let wallet_taker = self.wallet_taker;

        self.send(self.creation(self.terms(count)))
            .expect("create market");
        self.send(self.init_book(&admin_key)).expect("init book");
        self.send(self.manage(true)).expect("open market");

        // Set up owner accounts and initial deposit (20_000_000 atoms = 20 USDC)
        self.send(self.position_init(&owner_key))
            .expect("init owner pos");
        self.send(self.balance_init(&owner_key))
            .expect("init owner bal");
        self.send(self.asset_transfer(&owner_key, wallet_owner, 20_000_000, false))
            .expect("deposit owner");

        // Set up taker accounts and initial deposit (20_000_000 atoms = 20 USDC)
        self.send(self.position_init(&taker_key))
            .expect("init taker pos");
        self.send(self.balance_init(&taker_key))
            .expect("init taker bal");
        self.send(self.asset_transfer(&taker_key, wallet_taker, 20_000_000, false))
            .expect("deposit taker");
    }

    /// Asserts that an instruction fails and verifies that the error log contains `code`.
    fn reject(&mut self, ix: Instruction, code: Option<&str>) {
        let failure = self.send(ix).expect_err("must reject");
        if let Some(code) = code {
            assert!(
                failure
                    .meta
                    .logs
                    .iter()
                    .any(|l| l.contains(&format!("Error Code: {code}"))),
                "expected error code {code}, got logs: {:?}",
                failure.meta.logs
            );
        }
    }
}

// ============================================================================
// Integration Tests
// ============================================================================

/// Tests `InitializeMultiOutcomeBook`:
/// - Rejects non-admin wallets (missing `AdminRecord` fails closed).
/// - Rejects disabled administrators (`AdminDisabled`).
/// - Successful initialization by an active-admin creator creates a zeroed book root.
/// - Duplicate initialization fails (PDA collision prevented by `init`).
#[test]
fn multi_outcome_book_initialization_and_access_control() {
    let mut f = Fixture::new();
    let terms = f.terms(3);
    f.send(f.creation(terms)).expect("create market");

    let attacker_key = f.attacker.pubkey();
    let admin_key = f.admin.pubkey();

    // 1. Attacker without an admin record is rejected
    f.reject(f.init_book(&attacker_key), Some("AccountNotInitialized"));

    // 2. Disabled administrator is rejected
    let attacker_admin_key = pda(ADMIN_SEED, &[attacker_key.as_ref()]);
    let bump = Pubkey::find_program_address(&[ADMIN_SEED, attacker_key.as_ref()], &outcomia::ID).1;
    store(
        &mut f.svm,
        attacker_admin_key,
        &AdminRecord {
            authority: attacker_key,
            added_by: admin_key,
            status: AdminStatus::Disabled,
            bump,
        },
    );
    f.reject(f.init_book(&attacker_key), Some("AdminDisabled"));

    // 3. Active-admin creator initializes the book root
    let res = f.send(f.init_book(&admin_key));
    res.expect("init book");

    let book = f.book();
    assert_eq!(book.market, f.market_key());
    assert_eq!(book.authority, f.admin.pubkey());
    assert_eq!(book.next_order_id, 1);
    assert_eq!(book.accrued_collateral_fees, 0);
    assert!(book.orders.is_empty());

    // 4. Duplicate book initialization cannot overwrite or reset existing counters
    f.reject(f.init_book(&admin_key), None);
}

/// Tests resting order placement (`PlaceMultiOutcomeOrder`) for both Bids and Asks:
/// - **Bid**: Locks `price * quantity` collateral atoms from free cash into locked cash.
/// - **Ask**: Locks `quantity` outcome contracts from free position into locked position.
/// - Verifies state updates on `MultiOutcomeOrder`, `MultiOutcomeBook`, and event emission.
#[test]
fn place_bid_and_ask_orders_and_verify_locks() {
    let mut f = Fixture::new();
    f.setup_active_market(3);

    let owner_key = f.owner.pubkey();
    let taker_key = f.taker.pubkey();
    let outcome0 = OutcomeId::new(0, 3).unwrap();
    let price_bid = 400_000; // 0.40 collateral per contract
    let quantity_lot = 3; // multiple of quantity lot (3)

    // 1. Owner places a Bid for Outcome 0 at 400_000 for quantity 3:
    // Total lock required = 400_000 * 3 = 1_200_000 atoms
    let bid_ix = f.place_order(
        &owner_key,
        outcome0,
        OrderSide::Bid,
        price_bid,
        quantity_lot,
        1,
    );
    let res = f.send(bid_ix);
    res.as_ref().expect("place bid");

    // Verify order placement event
    let ev = single_event::<outcomia::MultiOutcomeOrderEvent>(&res);
    assert_eq!(ev.outcome, outcome0);
    assert_eq!(ev.side, OrderSide::Bid);
    assert_eq!(ev.price, price_bid);
    assert_eq!(ev.quantity, quantity_lot);
    assert_eq!(ev.status, OrderStatus::Open);

    // Verify cash balance delta: free decreased by 1_200_000, locked increased by 1_200_000
    let bal = f.balance(&owner_key);
    assert_eq!(bal.locked, 1_200_000);
    assert_eq!(bal.free, 20_000_000 - 1_200_000);

    // Verify resting order account fields
    let order = f.order(1);
    assert_eq!(order.order_id, 1);
    assert_eq!(order.outcome, outcome0);
    assert_eq!(order.side, OrderSide::Bid);
    assert_eq!(order.remaining_quantity, quantity_lot);
    assert_eq!(order.locked_amount, 1_200_000);
    assert_eq!(order.status, OrderStatus::Open);

    // Verify book summary reference and sequential order ID increment
    let book = f.book();
    assert_eq!(book.next_order_id, 2);
    assert_eq!(book.orders.len(), 1);
    assert_eq!(book.orders[0].order_id, 1);
    assert_eq!(book.orders[0].price, price_bid);

    // 2. Counterparty (taker) splits 6 complete sets to acquire outcome tokens
    f.send(f.complete(&taker_key, 6, true))
        .expect("split complete set");
    let pos = f.position(&taker_key);
    assert_eq!(pos.free[0], 6);
    assert_eq!(pos.free[1], 6);
    assert_eq!(pos.free[2], 6);

    // 3. Taker places an Ask for Outcome 0 at 600_000 for quantity 3:
    // Requires locking 3 Outcome 0 contracts (not cash)
    let price_ask = 600_000;
    let ask_ix = f.place_order(
        &taker_key,
        outcome0,
        OrderSide::Ask,
        price_ask,
        quantity_lot,
        2,
    );
    let res = f.send(ask_ix);
    res.as_ref().expect("place ask");

    // Verify position delta: free decreased from 6 to 3, locked increased from 0 to 3
    let pos_after = f.position(&taker_key);
    assert_eq!(pos_after.free[0], 3);
    assert_eq!(pos_after.locked[0], 3);

    // Verify order fields for Ask
    let order2 = f.order(2);
    assert_eq!(order2.order_id, 2);
    assert_eq!(order2.side, OrderSide::Ask);
    assert_eq!(order2.remaining_quantity, quantity_lot);
    assert_eq!(order2.locked_amount, 3);

    let book = f.book();
    assert_eq!(book.next_order_id, 3);
    assert_eq!(book.orders.len(), 2);
}

/// Tests validation constraints on resting order placement:
/// - Resting orders cannot cross existing opposite-side best prices (`InvalidPrice`).
/// - Order ID must strictly equal `book.next_order_id` (`InvalidOrderId`).
/// - Price must be an exact multiple of `price_tick` (`InvalidMultiOutcomePrice`).
/// - Quantity must be an exact multiple of `quantity_lot` (`InvalidMultiOutcomeLot`).
/// - Price cannot equal or exceed `payout_per_contract` (`InvalidMultiOutcomePrice`).
#[test]
fn place_order_rejects_crossing_spread_and_invalid_inputs() {
    let mut f = Fixture::new();
    f.setup_active_market(3);

    let owner_key = f.owner.pubkey();
    let taker_key = f.taker.pubkey();
    let outcome0 = OutcomeId::new(0, 3).unwrap();

    // Seed book with a resting Bid at 500_000
    f.send(f.place_order(&owner_key, outcome0, OrderSide::Bid, 500_000, 3, 1))
        .expect("resting bid");

    // Fund taker with outcome tokens
    f.send(f.complete(&taker_key, 6, true)).expect("split");

    // 1. Placing an Ask at or below resting Bid (<= 500_000) crosses the spread and must be rejected
    f.reject(
        f.place_order(&taker_key, outcome0, OrderSide::Ask, 500_000, 3, 2),
        Some("InvalidPrice"),
    );
    f.reject(
        f.place_order(&taker_key, outcome0, OrderSide::Ask, 400_000, 3, 2),
        Some("InvalidPrice"),
    );

    // 2. Skipping the next sequential order ID is rejected
    f.reject(
        f.place_order(&taker_key, outcome0, OrderSide::Ask, 600_000, 3, 99),
        Some("InvalidOrderId"),
    );

    // 3. Off-tick price (605_000 is not a multiple of price_tick 10_000) is rejected
    f.reject(
        f.place_order(&taker_key, outcome0, OrderSide::Ask, 605_000, 3, 2),
        Some("InvalidMultiOutcomePrice"),
    );

    // 4. Off-lot quantity (4 is not a multiple of quantity_lot 3) is rejected
    f.reject(
        f.place_order(&taker_key, outcome0, OrderSide::Ask, 600_000, 4, 2),
        Some("InvalidMultiOutcomeLot"),
    );

    // 5. Price equal to or greater than face payout (1_000_000) is economically irrational and rejected
    f.reject(
        f.place_order(&taker_key, outcome0, OrderSide::Ask, 1_000_000, 3, 2),
        Some("InvalidMultiOutcomePrice"),
    );
}

/// Tests `CancelMultiOutcomeOrder`:
/// - Canceling a Bid refunds locked cash back to free cash.
/// - Canceling an Ask refunds locked contracts back to free position.
/// - Non-owners cannot cancel other users' orders (`UnauthorizedSharedOrderOwner`).
/// - Replaying a cancellation is rejected.
/// - Invariant: cancellation remains available after the market is Frozen or Resolved.
#[test]
fn cancel_bid_and_ask_orders_refunds_escrow_correctly() {
    let mut f = Fixture::new();
    f.setup_active_market(3);

    let owner_key = f.owner.pubkey();
    let attacker_key = f.attacker.pubkey();
    let taker_key = f.taker.pubkey();
    let outcome0 = OutcomeId::new(0, 3).unwrap();

    // 1. Owner places a Bid locking 1_200_000 cash
    f.send(f.place_order(&owner_key, outcome0, OrderSide::Bid, 400_000, 3, 1))
        .expect("bid");

    // Initialize attacker accounts to verify signed authorization check
    f.send(f.balance_init(&attacker_key))
        .expect("init attacker bal");
    f.send(f.position_init(&attacker_key))
        .expect("init attacker pos");

    // 2. Attacker cannot cancel owner's order
    f.reject(
        f.cancel_order(&attacker_key, 1),
        Some("UnauthorizedSharedOrderOwner"),
    );

    // 3. Owner cancels order: verify locked cash is fully refunded to free cash
    let res = f.send(f.cancel_order(&owner_key, 1));
    res.as_ref().expect("cancel bid");
    let ev = single_event::<outcomia::MultiOutcomeOrderEvent>(&res);
    assert_eq!(ev.status, OrderStatus::Canceled);

    let bal = f.balance(&owner_key);
    assert_eq!(bal.locked, 0);
    assert_eq!(bal.free, 20_000_000);

    let order = f.order(1);
    assert_eq!(order.status, OrderStatus::Canceled);
    assert_eq!(order.remaining_quantity, 0);
    assert_eq!(order.locked_amount, 0);
    assert!(f.book().orders.is_empty());

    // 4. Replay of cancellation fails
    f.reject(
        f.cancel_order(&owner_key, 1),
        Some("InvalidMultiOutcomeBook"),
    );

    // 5. Taker places Ask order locking 3 outcome contracts
    f.send(f.complete(&taker_key, 3, true)).expect("split");
    f.send(f.place_order(&taker_key, outcome0, OrderSide::Ask, 600_000, 3, 2))
        .expect("ask");

    let pos = f.position(&taker_key);
    assert_eq!(pos.free[0], 0);
    assert_eq!(pos.locked[0], 3);

    // Advance clock past cutoff (200) and freeze market
    let mut clock = f.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = 200;
    f.svm.set_sysvar(&clock);
    f.send(f.advance(0)).expect("freeze market");
    assert_eq!(f.market().status, PredictionStatus::Frozen);

    // 6. Invariant: order owners can ALWAYS cancel resting orders even when trading is frozen
    f.send(f.cancel_order(&taker_key, 2))
        .expect("cancel while frozen");
    let pos_after = f.position(&taker_key);
    assert_eq!(pos_after.free[0], 3);
    assert_eq!(pos_after.locked[0], 0);
}

/// Tests `MatchMultiOutcomeOrder` (Bid taker vs Ask maker):
/// - Executes at maker price (400_000), NOT taker limit (450_000).
/// - Charges quote-denominated protocol taker fee (100 bps = 24_000 atoms).
/// - Maker receives 2_400_000 cash; taker receives 6 outcome contracts.
/// - Maker order is fully filled and purged from the order book.
/// - Book `accrued_collateral_fees` is updated.
#[test]
fn match_bid_taker_against_resting_ask_maker_with_fee_accrual() {
    let mut f = Fixture::new();
    f.setup_active_market(3);

    let owner_key = f.owner.pubkey();
    let taker_key = f.taker.pubkey();
    let outcome1 = OutcomeId::new(1, 3).unwrap();

    // 1. Maker (owner) splits 6 complete sets and rests an Ask for Outcome 1 at 400_000 for quantity 6
    f.send(f.complete(&owner_key, 6, true)).expect("split");
    f.send(f.place_order(&owner_key, outcome1, OrderSide::Ask, 400_000, 6, 1))
        .expect("maker ask");

    let maker_pos_before = f.position(&owner_key);
    assert_eq!(maker_pos_before.locked[1], 6);
    let maker_cash_before = f.balance(&owner_key).free;
    let taker_cash_before = f.balance(&taker_key).free;

    // 2. Taker sends a Bid match for 6 contracts at limit price 450_000 (with expected fee 100 bps):
    // Execution price = maker price 400_000
    // Gross cost = 6 * 400_000 = 2_400_000 atoms
    // Protocol fee = 1% (100 bps) of 2_400_000 = 24_000 atoms
    let match_ix = f.match_order(
        &taker_key,
        &owner_key,
        1,
        outcome1,
        OrderSide::Bid,
        450_000,
        6,
        100,
    );
    let res = f.send(match_ix);
    res.as_ref().expect("match fill");

    // Verify fill event parameters
    let ev = single_event::<outcomia::MultiOutcomeFillEvent>(&res);
    assert_eq!(ev.outcome, outcome1);
    assert_eq!(ev.taker_side, OrderSide::Bid);
    assert_eq!(ev.price, 400_000);
    assert_eq!(ev.quantity, 6);
    assert_eq!(ev.collateral_atoms, 2_400_000);
    assert_eq!(ev.fee_atoms, 24_000);

    // 3. Taker paid cost + fee
    let taker_cash_after = f.balance(&taker_key).free;
    assert_eq!(taker_cash_after, taker_cash_before - (2_400_000 + 24_000));
    // Taker received 6 Outcome 1 contracts in free balance
    assert_eq!(f.position(&taker_key).free[1], 6);

    // 4. Maker received exact notional (no fee debited from maker)
    let maker_cash_after = f.balance(&owner_key).free;
    assert_eq!(maker_cash_after, maker_cash_before + 2_400_000);
    // Maker locked contracts debited
    assert_eq!(f.position(&owner_key).locked[1], 0);

    // 5. Maker order is completely filled and removed from book queue
    let order = f.order(1);
    assert_eq!(order.status, OrderStatus::Filled);
    assert_eq!(order.remaining_quantity, 0);
    assert_eq!(order.locked_amount, 0);
    assert!(f.book().orders.is_empty());

    // 6. Fee accumulator in book records fee revenue
    assert_eq!(f.book().accrued_collateral_fees, 24_000);
}

/// Tests partial fill matching (Ask taker vs resting Bid maker):
/// - Maker rests Bid for 6 contracts; Taker matches 3 contracts.
/// - Maker order remains `Open` with remaining quantity 3 and remaining locked cash 1_500_000.
/// - Taker receives net proceeds after fee deduction: `cost - fee = 1_500_000 - 15_000 = 1_485_000`.
/// - Order reference is preserved in `book.orders`.
#[test]
fn match_ask_taker_against_resting_bid_maker_partial_fill() {
    let mut f = Fixture::new();
    f.setup_active_market(3);

    let owner_key = f.owner.pubkey();
    let taker_key = f.taker.pubkey();
    let outcome2 = OutcomeId::new(2, 3).unwrap();

    // 1. Maker rests Bid on Outcome 2 at 500_000 for quantity 6 (locks 3_000_000 cash)
    f.send(f.place_order(&owner_key, outcome2, OrderSide::Bid, 500_000, 6, 1))
        .expect("maker bid");

    // 2. Taker splits complete sets to obtain Outcome 2 contracts
    f.send(f.complete(&taker_key, 6, true)).expect("split");

    let taker_cash_before = f.balance(&taker_key).free;
    let maker_cash_before = f.balance(&owner_key).locked;

    // 3. Taker matches 3 contracts:
    // Cost = 3 * 500_000 = 1_500_000 atoms
    // Fee = 100 bps of 1_500_000 = 15_000 atoms
    // Taker net proceeds = 1_500_000 - 15_000 = 1_485_000 atoms
    let match_ix = f.match_order(
        &taker_key,
        &owner_key,
        1,
        outcome2,
        OrderSide::Ask,
        500_000,
        3,
        100,
    );
    f.send(match_ix).expect("partial match fill");

    // 4. Verify balances
    assert_eq!(f.balance(&taker_key).free, taker_cash_before + 1_485_000);
    assert_eq!(f.position(&taker_key).free[2], 3); // 6 - 3 = 3

    assert_eq!(f.balance(&owner_key).locked, maker_cash_before - 1_500_000);
    assert_eq!(f.position(&owner_key).free[2], 3);

    // 5. Resting order remains Open with updated remainder
    let order = f.order(1);
    assert_eq!(order.status, OrderStatus::Open);
    assert_eq!(order.remaining_quantity, 3);
    assert_eq!(order.locked_amount, 1_500_000);

    let book = f.book();
    assert_eq!(book.orders.len(), 1);
    assert_eq!(book.accrued_collateral_fees, 15_000);
}

/// Tests price-time (FIFO) priority enforcement:
/// - Three resting maker bids: Order 1 @ 400_000, Order 2 @ 450_000, Order 3 @ 450_000.
/// - Order 2 is best price (450_000) and FIFO head.
/// - Matching Order 1 is rejected (`MakerNotAtBestPrice`).
/// - Matching Order 3 is rejected (`MakerNotFifoHead`).
/// - Matching Order 2 succeeds, after which Order 3 becomes the new FIFO head.
#[test]
fn match_enforces_price_and_fifo_head_priority() {
    let mut f = Fixture::new();
    f.setup_active_market(3);

    let owner_key = f.owner.pubkey();
    let admin_key = f.admin.pubkey();
    let taker_key = f.taker.pubkey();
    let outcome0 = OutcomeId::new(0, 3).unwrap();

    // 1. Order 1: Owner Bid at 400_000
    f.send(f.place_order(&owner_key, outcome0, OrderSide::Bid, 400_000, 3, 1))
        .expect("bid 1");

    // Set up admin as a trader to place Order 2
    f.send(f.position_init(&admin_key)).expect("admin pos");
    f.send(f.balance_init(&admin_key)).expect("admin bal");

    let mut data = vec![0; TokenAccount::LEN];
    TokenAccount::pack(
        TokenAccount {
            mint: f.mint,
            owner: admin_key,
            amount: 50_000_000,
            delegate: None.into(),
            state: AccountState::Initialized,
            is_native: None.into(),
            delegated_amount: 0,
            close_authority: None.into(),
        },
        &mut data,
    )
    .expect("pack admin wallet");
    f.svm
        .set_account(
            f.wallet_admin,
            Account {
                lamports: f.svm.minimum_balance_for_rent_exemption(data.len()),
                data,
                owner: anchor_spl::token::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .expect("store admin wallet");
    let wallet_admin = f.wallet_admin;
    f.send(f.asset_transfer(&admin_key, wallet_admin, 10_000_000, false))
        .expect("deposit admin");

    // 2. Order 2: Admin Bid at 450_000 (superior price)
    f.send(f.place_order(&admin_key, outcome0, OrderSide::Bid, 450_000, 3, 2))
        .expect("bid 2");

    // 3. Order 3: Owner Bid at 450_000 (same price, but arrived later)
    f.send(f.place_order(&owner_key, outcome0, OrderSide::Bid, 450_000, 3, 3))
        .expect("bid 3");

    // Fund taker with outcome tokens
    f.send(f.complete(&taker_key, 6, true)).expect("split");

    // 4. Priority Check: matching Order 1 (price 400_000) fails because Order 2 offers 450_000
    f.reject(
        f.match_order(
            &taker_key,
            &owner_key,
            1,
            outcome0,
            OrderSide::Ask,
            400_000,
            3,
            100,
        ),
        Some("MakerNotAtBestPrice"),
    );

    // 5. FIFO Check: matching Order 3 (price 450_000) fails because Order 2 has FIFO precedence
    f.reject(
        f.match_order(
            &taker_key,
            &owner_key,
            3,
            outcome0,
            OrderSide::Ask,
            450_000,
            3,
            100,
        ),
        Some("MakerNotFifoHead"),
    );

    // 6. Matching Order 2 (best price and FIFO head) succeeds!
    f.send(f.match_order(
        &taker_key,
        &admin_key,
        2,
        outcome0,
        OrderSide::Ask,
        450_000,
        3,
        100,
    ))
    .expect("match best fifo head");

    // 7. After Order 2 is filled, Order 3 becomes the next valid FIFO head at 450_000
    f.send(f.match_order(
        &taker_key,
        &owner_key,
        3,
        outcome0,
        OrderSide::Ask,
        450_000,
        3,
        100,
    ))
    .expect("match next fifo head");
}

/// Tests self-trade rejection and fee quote validation:
/// - Rejects matching against oneself (duplicate mutable account check).
/// - Rejects trades where the client's expected fee does not match protocol config (`MultiOutcomeFeeQuoteChanged`).
#[test]
fn match_rejects_self_trade_and_stale_fee_quote() {
    let mut f = Fixture::new();
    f.setup_active_market(3);

    let owner_key = f.owner.pubkey();
    let taker_key = f.taker.pubkey();
    let outcome0 = OutcomeId::new(0, 3).unwrap();

    f.send(f.place_order(&owner_key, outcome0, OrderSide::Bid, 400_000, 3, 1))
        .expect("bid");

    // 1. Taker attempting to trade against their own order is rejected at account validation level
    f.reject(
        f.match_order(
            &owner_key,
            &owner_key,
            1,
            outcome0,
            OrderSide::Ask,
            400_000,
            3,
            100,
        ),
        Some("ConstraintDuplicateMutableAccount"),
    );

    // 2. Stale fee quote: protocol fee is 100 bps (1%), but taker signed expected fee of 50 bps
    f.send(f.complete(&taker_key, 3, true)).expect("split");
    f.reject(
        f.match_order(
            &taker_key,
            &owner_key,
            1,
            outcome0,
            OrderSide::Ask,
            400_000,
            3,
            50,
        ),
        Some("MultiOutcomeFeeQuoteChanged"),
    );
}

/// Tests `WithdrawMultiOutcomeFees`:
/// - Rejects non-super-admin callers (`UnauthorizedAdmin`).
/// - Super-admin transfers accumulated trading fees from global asset vault to treasury wallet.
/// - Fee counter resets without mutating trader positions or market reserve.
#[test]
fn super_admin_withdraws_accrued_trading_fees() {
    let mut f = Fixture::new();
    f.setup_active_market(3);

    let owner_key = f.owner.pubkey();
    let attacker_key = f.attacker.pubkey();
    let taker_key = f.taker.pubkey();
    let outcome0 = OutcomeId::new(0, 3).unwrap();

    // Generate trading fee revenue: 3 contracts @ 400_000 * 100 bps = 12_000 fee atoms
    f.send(f.complete(&owner_key, 3, true)).expect("split");
    f.send(f.place_order(&owner_key, outcome0, OrderSide::Ask, 400_000, 3, 1))
        .expect("ask");
    f.send(f.match_order(
        &taker_key,
        &owner_key,
        1,
        outcome0,
        OrderSide::Bid,
        450_000,
        3,
        100,
    ))
    .expect("match");
    assert_eq!(f.book().accrued_collateral_fees, 12_000);

    // 1. Attacker is rejected
    let mut attacker_ix = f.withdraw_fees(12_000);
    attacker_ix.accounts[0].pubkey = attacker_key;
    f.reject(attacker_ix, Some("UnauthorizedAdmin"));

    // 2. Super-admin withdraws 12_000 fee atoms
    let admin_tokens_before = f.tokens(f.wallet_admin);
    let res = f.send(f.withdraw_fees(12_000));
    res.as_ref().expect("withdraw fees");

    let ev = single_event::<outcomia::MultiOutcomeFeeWithdrawnEvent>(&res);
    assert_eq!(ev.amount, 12_000);
    assert_eq!(ev.authority, f.admin.pubkey());

    // Verify token account balance increased by exact fee amount
    assert_eq!(f.tokens(f.wallet_admin), admin_tokens_before + 12_000);
    assert_eq!(f.book().accrued_collateral_fees, 0);
}

/// Tests outcome proposal, delay maturity, finalization, and winner redemption:
/// - Primary resolver proposes `Winner(Outcome 1)`.
/// - Premature finalization before resolution delay is rejected.
/// - Finalization sets `final_outcome = Some(Winner(Outcome 1))` and status `Resolved`.
/// - Redeeming winning contracts pays full face value `P` (1_000_000 atoms per contract).
/// - Losing contracts burn for 0 payout without error.
#[test]
fn resolution_lifecycle_proposal_advance_and_winner_redemption() {
    let mut f = Fixture::new();
    f.setup_active_market(3);

    let owner_key = f.owner.pubkey();
    let admin_key = f.admin.pubkey();

    // Split 6 complete sets (6 of Outcome 0, 1, 2)
    f.send(f.complete(&owner_key, 6, true)).expect("split");

    // Advance clock past close timestamp (close_ts = 200)
    let mut clock = f.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = 205;
    f.svm.set_sysvar(&clock);

    // 1. Primary resolver proposes Outcome 1 as the winner
    let outcome1 = OutcomeId::new(1, 3).unwrap();
    let proposal_ix = f.propose(
        &admin_key,
        MultiOutcomeResolution::Winner(outcome1),
        "ar://evidence-hash".into(),
        [9; 32],
        false,
    );
    let res = f.send(proposal_ix);
    res.as_ref().expect("propose");

    let ev = single_event::<outcomia::MultiOutcomeResolutionEvent>(&res);
    assert_eq!(ev.outcome, Some(MultiOutcomeResolution::Winner(outcome1)));
    assert_eq!(ev.status, PredictionStatus::Proposed);

    // 2. Cannot advance to finalize before resolution delay (10s) expires:
    // Timestamp 210 is only 5s after proposal at 205
    clock.unix_timestamp = 210;
    f.svm.set_sysvar(&clock);
    f.reject(f.advance(2), Some("PredictionProposalUnavailable"));

    // 3. Advance past maturity (205 + 10 = 215)
    clock.unix_timestamp = 216;
    f.svm.set_sysvar(&clock);

    let advance_res = f.send(f.advance(2));
    advance_res.as_ref().expect("finalize proposal");

    let market = f.market();
    assert_eq!(market.status, PredictionStatus::Resolved);
    assert_eq!(
        market.final_outcome,
        Some(MultiOutcomeResolution::Winner(outcome1))
    );

    // 4. Owner redeems 6 Outcome 1 (winner) and 6 Outcome 0 (loser):
    // Payout = 6 * 1_000_000 = 6_000_000 collateral atoms
    let mut quantities = [0u64; 8];
    quantities[0] = 6;
    quantities[1] = 6;

    let owner_cash_before = f.balance(&owner_key).free;
    let redeem_res = f.send(f.redeem(&owner_key, quantities));
    redeem_res.as_ref().expect("redeem winner");

    let ev = single_event::<outcomia::MultiOutcomeRedeemedEvent>(&redeem_res);
    assert_eq!(ev.payout, 6_000_000);
    assert_eq!(ev.outcome, MultiOutcomeResolution::Winner(outcome1));

    // Free collateral credited by exact payout
    assert_eq!(f.balance(&owner_key).free, owner_cash_before + 6_000_000);

    // Positions for 0 and 1 are cleared
    let pos = f.position(&owner_key);
    assert_eq!(pos.free[0], 0);
    assert_eq!(pos.free[1], 0);
    assert_eq!(pos.free[2], 6); // unredeemed Outcome 2 remains intact
}

/// Tests resolution timeout to `Invalid` and exact fractional refund redemption:
/// - When resolver fails to propose before fallback deadline, Action 3 advances to `Invalid`.
/// - Verifies the core economic invariant: `(quantity_lot * payout) % N == 0`.
/// - Every outcome contract receives an exact `(L * P) / N` refund per contract.
/// - Full 3_000_000 reserve is returned with zero residual dust in the vault.
#[test]
fn resolution_timeout_to_invalid_and_exact_refund_redemption() {
    let mut f = Fixture::new();
    f.setup_active_market(3);

    let owner_key = f.owner.pubkey();

    // Owner splits 3 complete sets (3 of A, B, C; cost = 3 * 1_000_000 = 3_000_000 atoms)
    f.send(f.complete(&owner_key, 3, true)).expect("split");

    // Advance clock past close_ts (200) and past fallback deadline (300)
    let mut clock = f.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = 305;
    f.svm.set_sysvar(&clock);

    // 1. Action 3 advances to Invalid outcome on timeout
    let advance_res = f.send(f.advance(3));
    advance_res.as_ref().expect("invalid timeout");

    let market = f.market();
    assert_eq!(market.status, PredictionStatus::Resolved);
    assert_eq!(market.final_outcome, Some(MultiOutcomeResolution::Invalid));

    // Under Invalid, each complete set of 3 contracts refunds 1_000_000 atoms:
    // (lot * payout) / N = (3 * 1_000_000) / 3 = 1_000_000 atoms for 3 contracts
    let owner_cash_before = f.balance(&owner_key).free;

    // 2. Redeem 3 Outcome 0 contracts -> yields exactly 1_000_000 atoms
    let mut q = [0u64; 8];
    q[0] = 3;
    f.send(f.redeem(&owner_key, q))
        .expect("redeem invalid outcome 0");
    assert_eq!(f.balance(&owner_key).free, owner_cash_before + 1_000_000);

    // 3. Redeem 3 Outcome 1 contracts -> yields another 1_000_000 atoms
    q = [0u64; 8];
    q[1] = 3;
    f.send(f.redeem(&owner_key, q))
        .expect("redeem invalid outcome 1");
    assert_eq!(f.balance(&owner_key).free, owner_cash_before + 2_000_000);

    // 4. Redeem 3 Outcome 2 contracts -> yields the final 1_000_000 atoms
    q = [0u64; 8];
    q[2] = 3;
    f.send(f.redeem(&owner_key, q))
        .expect("redeem invalid outcome 2");
    assert_eq!(f.balance(&owner_key).free, owner_cash_before + 3_000_000);

    // 5. Invariant check: all contracts burned and exactly 100% of collateral reserve drained (zero dust)
    assert_eq!(f.market().backing_reserve, 0);
    assert_eq!(f.tokens(f.reserve()), 0);
}
