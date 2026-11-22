//! LiteSVM coverage for binary club markets: creation, lifecycle, custody,
//! resolution and isolation from public instructions.

#![allow(clippy::result_large_err)]

use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack, system_program},
    AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token::state::{Account as TokenState, AccountState, Mint};
use litesvm::LiteSVM;
use outcomia::{constants::*, prediction_config::PredictionMarketConfig, state::*};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use OrderSide::{Ask, Bid};
use SharedOutcome::{No, Yes};

const PROGRAM_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/outcomia.so"
));
const CLUB_ID: [u8; 32] = [7; 32];
const MARKET_ID: [u8; 32] = [3; 32];
const PAYOUT: u64 = 1_000_000;

fn pda(seed: &[u8], parts: &[&[u8]]) -> Pubkey {
    let mut seeds = vec![seed];
    seeds.extend_from_slice(parts);
    Pubkey::find_program_address(&seeds, &outcomia::ID).0
}
fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction::new_with_bytes(outcomia::ID, &data.data(), accounts.to_account_metas(None))
}

struct Fixture {
    svm: LiteSVM,
    owner: Keypair,
    club: Pubkey,
    mint: Pubkey,
}

impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM_BYTES).unwrap();
        let owner = Keypair::new();
        svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
        let mint = Pubkey::new_unique();
        let mut data = vec![0; Mint::LEN];
        Mint::pack(
            Mint {
                mint_authority: Some(owner.pubkey()).into(),
                supply: 1_000_000_000_000,
                decimals: 6,
                is_initialized: true,
                freeze_authority: None.into(),
            },
            &mut data,
        )
        .unwrap();
        let lamports = svm.minimum_balance_for_rent_exemption(data.len());
        svm.set_account(
            mint,
            Account {
                lamports,
                data,
                owner: anchor_spl::token::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        let mut f = Fixture {
            svm,
            owner,
            club: pda(CLUB_SEED, &[&CLUB_ID]),
            mint,
        };
        f.set_clock(100);
        let owner = f.owner.insecure_clone();
        f.ok(
            &owner,
            ix(
                outcomia::accounts::CreateClub {
                    owner: owner.pubkey(),
                    club: f.club,
                    owner_member: f.member_pda(&owner.pubkey()),
                    system_program: system_program::ID,
                },
                outcomia::instruction::CreateClub {
                    club_id: CLUB_ID,
                    name: "Club".into(),
                },
            ),
        );
        f
    }
    fn wallet(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
        k
    }
    fn member_pda(&self, wallet: &Pubkey) -> Pubkey {
        pda(CLUB_MEMBER_SEED, &[self.club.as_ref(), wallet.as_ref()])
    }
    /// Invites and accepts a fresh wallet; promotes it when `admin`.
    fn join(&mut self, admin: bool) -> Keypair {
        let owner = self.owner.insecure_clone();
        let wallet = self.wallet();
        let invite = pda(
            CLUB_INVITE_SEED,
            &[self.club.as_ref(), wallet.pubkey().as_ref()],
        );
        self.ok(
            &owner,
            ix(
                outcomia::accounts::InviteClubMember {
                    inviter: owner.pubkey(),
                    club: self.club,
                    inviter_member: self.member_pda(&owner.pubkey()),
                    existing_member: self.member_pda(&wallet.pubkey()),
                    invite,
                    system_program: system_program::ID,
                },
                outcomia::instruction::InviteClubMember {
                    wallet: wallet.pubkey(),
                },
            ),
        );
        self.ok(
            &wallet,
            ix(
                outcomia::accounts::AcceptClubInvite {
                    wallet: wallet.pubkey(),
                    club: self.club,
                    invite,
                    inviter: owner.pubkey(),
                    member: self.member_pda(&wallet.pubkey()),
                    system_program: system_program::ID,
                },
                outcomia::instruction::AcceptClubInvite {},
            ),
        );
        if admin {
            self.ok(
                &owner,
                ix(
                    outcomia::accounts::SetClubMemberRole {
                        owner: owner.pubkey(),
                        club: self.club,
                        member: self.member_pda(&wallet.pubkey()),
                    },
                    outcomia::instruction::SetClubMemberRole {
                        role: ClubRole::Admin,
                    },
                ),
            );
        }
        wallet
    }
    fn remove(&mut self, wallet: &Pubkey) {
        let owner = self.owner.insecure_clone();
        self.ok(
            &owner,
            ix(
                outcomia::accounts::RemoveClubMember {
                    admin: owner.pubkey(),
                    club: self.club,
                    admin_member: self.member_pda(&owner.pubkey()),
                    member: self.member_pda(wallet),
                    wallet: *wallet,
                },
                outcomia::instruction::RemoveClubMember {},
            ),
        );
    }
    fn set_clock(&mut self, now: i64) {
        let mut c = self.svm.get_sysvar::<Clock>();
        c.unix_timestamp = now;
        self.svm.set_sysvar(&c);
    }
    fn send(&mut self, signer: &Keypair, ix: Instruction) -> Result<(), Vec<String>> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(
            &[ix],
            Some(&signer.pubkey()),
            &self.svm.latest_blockhash(),
        );
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| e.meta.logs)
    }
    fn ok(&mut self, signer: &Keypair, ix: Instruction) {
        if let Err(logs) = self.send(signer, ix) {
            panic!("transaction should succeed: {logs:#?}");
        }
    }
    fn fails(&mut self, signer: &Keypair, ix: Instruction, error: &str) {
        let logs = self.send(signer, ix).expect_err("transaction should fail");
        let needle = format!("Error Code: {error}.");
        assert!(
            logs.iter().any(|l| l.contains(&needle)),
            "expected {error}: {logs:#?}"
        );
    }
    fn load<T: AccountDeserialize>(&self, address: &Pubkey) -> Option<T> {
        let account = self.svm.get_account(address)?;
        (!account.data.is_empty())
            .then(|| T::try_deserialize(&mut account.data.as_slice()).unwrap())
    }
    fn market(&self) -> PredictionMarket {
        self.load(&market_pda(&MARKET_ID)).unwrap()
    }

    fn token_amount(&self, address: &Pubkey) -> u64 {
        TokenState::unpack(&self.svm.get_account(address).unwrap().data)
            .unwrap()
            .amount
    }
    fn balance_pda(&self, owner: &Pubkey) -> Pubkey {
        pda(ASSET_BALANCE_SEED, &[owner.as_ref(), self.mint.as_ref()])
    }
    fn free_cash(&self, owner: &Pubkey) -> u64 {
        self.load::<AssetBalance>(&self.balance_pda(owner))
            .unwrap()
            .free
    }
    fn position(&self, owner: &Pubkey) -> PredictionPosition {
        let market = market_pda(&MARKET_ID);
        self.load(&pda(
            PREDICTION_POSITION_SEED,
            &[market.as_ref(), owner.as_ref()],
        ))
        .unwrap()
    }
    /// Deposits `amount` collateral atoms into the wallet's shared balance and
    /// creates its club position.
    fn fund(&mut self, wallet: &Keypair, amount: u64) {
        let token = self.token_account(&wallet.pubkey(), amount);
        let (owner, mint) = (wallet.pubkey(), self.mint);
        let balance = self.balance_pda(&owner);
        let authority = pda(ASSET_AUTHORITY_SEED, &[mint.as_ref()]);
        let vault = pda(ASSET_VAULT_SEED, &[mint.as_ref()]);
        self.ok(
            wallet,
            ix(
                outcomia::accounts::InitializeAssetBalance {
                    owner,
                    mint,
                    asset_balance: balance,
                    vault_authority: authority,
                    asset_vault: vault,
                    token_program: anchor_spl::token::ID,
                    system_program: system_program::ID,
                },
                outcomia::instruction::InitializeAssetBalance {},
            ),
        );
        self.ok(
            wallet,
            ix(
                outcomia::accounts::TransferAsset {
                    owner,
                    mint,
                    asset_balance: balance,
                    wallet_token: token,
                    vault_authority: authority,
                    asset_vault: vault,
                    token_program: anchor_spl::token::ID,
                },
                outcomia::instruction::DepositAsset { amount },
            ),
        );
        self.ok(wallet, self.init_position(&owner));
    }
    /// A token account of the collateral mint owned by `owner`.
    fn token_account(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let token = Pubkey::new_unique();
        let state = TokenState {
            mint: self.mint,
            owner: *owner,
            amount,
            delegate: None.into(),
            state: AccountState::Initialized,
            is_native: None.into(),
            delegated_amount: 0,
            close_authority: None.into(),
        };
        let mut data = vec![0; TokenState::LEN];
        TokenState::pack(state, &mut data).unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                token,
                Account {
                    lamports,
                    data,
                    owner: anchor_spl::token::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        token
    }
    fn custody_accounts(
        &self,
        owner: &Pubkey,
        with_member: bool,
    ) -> outcomia::accounts::ClubPredictionCustody {
        let market = market_pda(&MARKET_ID);
        outcomia::accounts::ClubPredictionCustody {
            owner: *owner,
            market,
            club_market: pda(CLUB_MARKET_SEED, &[market.as_ref()]),
            member: with_member.then(|| self.member_pda(owner)),
            position: pda(PREDICTION_POSITION_SEED, &[market.as_ref(), owner.as_ref()]),
            mint: self.mint,
            asset_balance: self.balance_pda(owner),
            asset_authority: pda(ASSET_AUTHORITY_SEED, &[self.mint.as_ref()]),
            asset_vault: pda(ASSET_VAULT_SEED, &[self.mint.as_ref()]),
            market_authority: pda(VAULT_AUTHORITY_SEED, &[market.as_ref()]),
            market_vault: pda(VAULT_SEED, &[market.as_ref(), self.mint.as_ref()]),
            token_program: anchor_spl::token::ID,
        }
    }
    fn complete_set(
        &self,
        owner: &Pubkey,
        with_member: bool,
        quantity: u64,
        split: bool,
    ) -> Instruction {
        ix(
            self.custody_accounts(owner, with_member),
            outcomia::instruction::ClubCompleteSet { quantity, split },
        )
    }
    fn market_vault(&self) -> Pubkey {
        pda(
            VAULT_SEED,
            &[market_pda(&MARKET_ID).as_ref(), self.mint.as_ref()],
        )
    }

    fn propose(
        &self,
        admin: &Pubkey,
        outcome: PredictionResolution,
        correction: bool,
    ) -> Instruction {
        let market = market_pda(&MARKET_ID);
        ix(
            outcomia::accounts::ProposeClubPrediction {
                admin: *admin,
                club_market: pda(CLUB_MARKET_SEED, &[market.as_ref()]),
                market,
                admin_member: self.member_pda(admin),
            },
            outcomia::instruction::ProposeClubPrediction {
                outcome,
                evidence_uri: format!("ar://{}", "e".repeat(43)),
                evidence_hash: [5; 32],
                correction,
            },
        )
    }
    fn advance(&self, action: u8) -> Instruction {
        ix(
            outcomia::accounts::AdvanceClubPrediction {
                market: market_pda(&MARKET_ID),
            },
            outcomia::instruction::AdvanceClubPrediction { action },
        )
    }
    fn redeem(&self, owner: &Pubkey, yes: u64, no: u64) -> Instruction {
        ix(
            self.custody_accounts(owner, false),
            outcomia::instruction::RedeemClubPrediction { yes, no },
        )
    }

    fn book(&self) -> Pubkey {
        pda(CLUB_BOOK_SEED, &[market_pda(&MARKET_ID).as_ref()])
    }
    fn order_pda(&self, id: u64) -> Pubkey {
        pda(
            SHARED_ORDER_SEED,
            &[self.book().as_ref(), &id.to_le_bytes()],
        )
    }
    fn level_pda(&self, outcome: SharedOutcome, side: OrderSide, price: u64) -> Pubkey {
        pda(
            SHARED_LEVEL_SEED,
            &[
                self.book().as_ref(),
                outcome.seed(),
                side.seed(),
                &price.to_le_bytes(),
            ],
        )
    }
    fn init_book(&self, actor: &Pubkey) -> Instruction {
        let market = market_pda(&MARKET_ID);
        ix(
            outcomia::accounts::InitializeClubBook {
                actor: *actor,
                club_market: pda(CLUB_MARKET_SEED, &[market.as_ref()]),
                market,
                actor_member: self.member_pda(actor),
                book: self.book(),
                system_program: system_program::ID,
            },
            outcomia::instruction::InitializeClubBook {},
        )
    }
    /// Places an order at a price no other order of that list uses yet.
    #[allow(clippy::too_many_arguments)]
    fn place(
        &self,
        owner: &Pubkey,
        with_member: bool,
        outcome: SharedOutcome,
        side: OrderSide,
        price: u64,
        quantity: u64,
        order_id: u64,
    ) -> Instruction {
        let market = market_pda(&MARKET_ID);
        ix(
            outcomia::accounts::PlaceClubOrder {
                owner: *owner,
                market,
                club_market: pda(CLUB_MARKET_SEED, &[market.as_ref()]),
                member: with_member.then(|| self.member_pda(owner)),
                book: self.book(),
                base_balance: None,
                quote_balance: self.balance_pda(owner),
                position: Some(pda(
                    PREDICTION_POSITION_SEED,
                    &[market.as_ref(), owner.as_ref()],
                )),
                order: self.order_pda(order_id),
                price_level: self.level_pda(outcome, side, price),
                tail: None,
                better_level: None,
                worse_level: None,
                system_program: system_program::ID,
            },
            outcomia::instruction::PlaceClubOrder {
                outcome,
                side,
                price,
                quantity,
                order_id,
            },
        )
    }
    /// Cancels an order that is alone at its level.
    fn cancel(&self, canceller: &Pubkey, order_id: u64) -> Instruction {
        let order: SharedOrder = self.load(&self.order_pda(order_id)).unwrap();
        let market = market_pda(&MARKET_ID);
        let level: SharedPriceLevel = self.load(&order.price_level).unwrap();
        ix(
            outcomia::accounts::CancelClubOrder {
                canceller: *canceller,
                club_market: pda(CLUB_MARKET_SEED, &[market.as_ref()]),
                book: self.book(),
                owner_member: self.member_pda(&order.owner),
                base_balance: None,
                quote_balance: self.balance_pda(&order.owner),
                position: Some(pda(
                    PREDICTION_POSITION_SEED,
                    &[market.as_ref(), order.owner.as_ref()],
                )),
                order: self.order_pda(order_id),
                price_level: order.price_level,
                previous_order: None,
                next_order: None,
                better_level: None,
                worse_level: None,
                level_rent_recipient: Some(level.rent_payer),
            },
            outcomia::instruction::CancelClubOrder {},
        )
    }
    fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm.get_account(address).map_or(0, |a| a.lamports)
    }
    fn locked_cash(&self, owner: &Pubkey) -> u64 {
        self.load::<AssetBalance>(&self.balance_pda(owner))
            .unwrap()
            .locked
    }
    fn club_book(&self) -> SharedBook {
        self.load(&self.book()).unwrap()
    }
    /// Opens the default market with a book, as the owner.
    fn open_book(&mut self, access: ClubMarketAccess) {
        self.open_market(access);
        let owner = self.owner.insecure_clone();
        self.ok(&owner, self.init_book(&owner.pubkey()));
    }

    fn store<T: AccountSerialize>(&mut self, address: Pubkey, value: &T) {
        let mut data = Vec::new();
        value.try_serialize(&mut data).unwrap();
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                address,
                Account {
                    lamports,
                    data,
                    owner: outcomia::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }
    /// Sets the protocol taker fee and, when given, the club share.
    fn set_fees(&mut self, taker_fee_bps: u16, club_share_bps: Option<u16>) {
        self.set_fees_with_admin(taker_fee_bps, club_share_bps, Pubkey::new_unique());
    }
    fn set_fees_with_admin(
        &mut self,
        taker_fee_bps: u16,
        club_share_bps: Option<u16>,
        super_admin: Pubkey,
    ) {
        let (config, bump) = Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &outcomia::ID);
        self.store(
            config,
            &ProtocolConfig {
                super_admin,
                taker_fee_bps,
                bump,
            },
        );
        if let Some(club_share_bps) = club_share_bps {
            let (address, bump) =
                Pubkey::find_program_address(&[CLUB_FEE_CONFIG_SEED], &outcomia::ID);
            self.store(
                address,
                &ClubFeeConfig {
                    club_share_bps,
                    bump,
                },
            );
        }
    }
    fn club_market(&self) -> ClubMarket {
        self.load(&pda(CLUB_MARKET_SEED, &[market_pda(&MARKET_ID).as_ref()]))
            .unwrap()
    }
    /// Fills against order `maker_id`, which must be alone at its level.
    #[allow(clippy::too_many_arguments)]
    fn take(
        &self,
        taker: &Pubkey,
        taker_member: bool,
        maker_member: bool,
        maker_id: u64,
        outcome: SharedOutcome,
        side: OrderSide,
        limit: u64,
        quantity: u64,
        complement: bool,
    ) -> Instruction {
        let maker: SharedOrder = self.load(&self.order_pda(maker_id)).unwrap();
        let level: SharedPriceLevel = self.load(&maker.price_level).unwrap();
        let market = market_pda(&MARKET_ID);
        let completes = quantity >= maker.remaining_quantity;
        let position = |o: &Pubkey| pda(PREDICTION_POSITION_SEED, &[market.as_ref(), o.as_ref()]);
        let club_market = pda(CLUB_MARKET_SEED, &[market.as_ref()]);
        let protocol_config = pda(PROTOCOL_CONFIG_SEED, &[]);
        let club_fee_config = pda(CLUB_FEE_CONFIG_SEED, &[]);
        let taker_member = taker_member.then(|| self.member_pda(taker));
        let maker_member = maker_member.then(|| self.member_pda(&maker.owner));
        let level_rent_recipient = completes.then_some(level.rent_payer);
        if complement {
            ix(
                outcomia::accounts::MatchClubComplement {
                    taker: *taker,
                    market,
                    club_market,
                    book: self.book(),
                    protocol_config,
                    club_fee_config,
                    taker_member,
                    maker_member,
                    maker_order: self.order_pda(maker_id),
                    price_level: maker.price_level,
                    maker_quote: self.balance_pda(&maker.owner),
                    maker_position: position(&maker.owner),
                    taker_quote: self.balance_pda(taker),
                    taker_position: position(taker),
                    mint: self.mint,
                    asset_authority: pda(ASSET_AUTHORITY_SEED, &[self.mint.as_ref()]),
                    asset_vault: pda(ASSET_VAULT_SEED, &[self.mint.as_ref()]),
                    market_authority: pda(VAULT_AUTHORITY_SEED, &[market.as_ref()]),
                    market_vault: self.market_vault(),
                    token_program: anchor_spl::token::ID,
                    next_order: None,
                    worse_level: None,
                    level_rent_recipient,
                },
                outcomia::instruction::MatchClubComplement {
                    outcome,
                    taker_side: side,
                    limit_price: limit,
                    quantity,
                },
            )
        } else {
            ix(
                outcomia::accounts::MatchClubOrder {
                    taker: *taker,
                    market,
                    club_market,
                    book: self.book(),
                    protocol_config,
                    club_fee_config,
                    taker_member,
                    maker_member,
                    maker_order: self.order_pda(maker_id),
                    price_level: maker.price_level,
                    maker_base: None,
                    maker_quote: self.balance_pda(&maker.owner),
                    maker_position: Some(position(&maker.owner)),
                    taker_base: None,
                    taker_quote: self.balance_pda(taker),
                    taker_position: Some(position(taker)),
                    next_order: None,
                    worse_level: None,
                    level_rent_recipient,
                },
                outcomia::instruction::MatchClubOrder {
                    outcome,
                    taker_side: side,
                    limit_price: limit,
                    quantity,
                },
            )
        }
    }
    /// Global vault tokens minus every wallet claim, book fee and club fee.
    fn vault_surplus(&self, wallets: &[&Pubkey]) -> i128 {
        let vault = self.token_amount(&pda(ASSET_VAULT_SEED, &[self.mint.as_ref()])) as i128;
        let claims: i128 = wallets
            .iter()
            .map(|w| {
                let b: AssetBalance = self.load(&self.balance_pda(w)).unwrap();
                (b.free + b.locked) as i128
            })
            .sum();
        vault
            - claims
            - self.club_book().accrued_quote_fees as i128
            - self.club_market().accrued_club_fees as i128
    }

    fn withdraw_club(&self, owner: &Pubkey, destination: Pubkey, amount: u64) -> Instruction {
        let market = market_pda(&MARKET_ID);
        ix(
            outcomia::accounts::WithdrawClubFees {
                owner: *owner,
                club: self.club,
                club_market: pda(CLUB_MARKET_SEED, &[market.as_ref()]),
                market,
                mint: self.mint,
                destination,
                vault_authority: pda(ASSET_AUTHORITY_SEED, &[self.mint.as_ref()]),
                asset_vault: pda(ASSET_VAULT_SEED, &[self.mint.as_ref()]),
                token_program: anchor_spl::token::ID,
            },
            outcomia::instruction::WithdrawClubFees { amount },
        )
    }
    fn withdraw_book(&self, super_admin: &Pubkey, destination: Pubkey, amount: u64) -> Instruction {
        ix(
            outcomia::accounts::WithdrawClubBookFees {
                super_admin: *super_admin,
                protocol_config: pda(PROTOCOL_CONFIG_SEED, &[]),
                book: self.book(),
                mint: self.mint,
                destination,
                vault_authority: pda(ASSET_AUTHORITY_SEED, &[self.mint.as_ref()]),
                asset_vault: pda(ASSET_VAULT_SEED, &[self.mint.as_ref()]),
                token_program: anchor_spl::token::ID,
            },
            outcomia::instruction::WithdrawClubBookFees { amount },
        )
    }

    fn create_market(
        &self,
        creator: &Pubkey,
        market_id: [u8; 32],
        config: PredictionMarketConfig,
        access: ClubMarketAccess,
    ) -> Instruction {
        let market = market_pda(&market_id);
        ix(
            outcomia::accounts::CreateClubPredictionMarket {
                creator: *creator,
                club: self.club,
                creator_member: self.member_pda(creator),
                market,
                club_market: pda(CLUB_MARKET_SEED, &[market.as_ref()]),
                collateral_mint: self.mint,
                vault_authority: pda(VAULT_AUTHORITY_SEED, &[market.as_ref()]),
                collateral_vault: pda(VAULT_SEED, &[market.as_ref(), self.mint.as_ref()]),
                market_metadata: pda(MARKET_METADATA_SEED, &[market.as_ref()]),
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            },
            outcomia::instruction::CreateClubPredictionMarket {
                market_id,
                config,
                display_name: "Will it rain?".into(),
                collateral_symbol: "USDC".into(),
                access,
            },
        )
    }
    fn manage(&self, actor: &Pubkey, open: bool) -> Instruction {
        let market = market_pda(&MARKET_ID);
        let accounts = outcomia::accounts::ManageClubPredictionMarket {
            actor: *actor,
            club_market: pda(CLUB_MARKET_SEED, &[market.as_ref()]),
            market,
            actor_member: self.member_pda(actor),
        };
        if open {
            ix(accounts, outcomia::instruction::OpenClubPredictionMarket {})
        } else {
            ix(accounts, outcomia::instruction::CloseClubTrading {})
        }
    }
    /// Creates and opens the default market as the owner.
    fn open_market(&mut self, access: ClubMarketAccess) {
        let owner = self.owner.insecure_clone();
        self.ok(
            &owner,
            self.create_market(&owner.pubkey(), MARKET_ID, config(&owner.pubkey()), access),
        );
        self.ok(&owner, self.manage(&owner.pubkey(), true));
    }
    fn init_position(&self, owner: &Pubkey) -> Instruction {
        let market = market_pda(&MARKET_ID);
        ix(
            outcomia::accounts::InitializeClubPosition {
                owner: *owner,
                market,
                position: pda(PREDICTION_POSITION_SEED, &[market.as_ref(), owner.as_ref()]),
                system_program: system_program::ID,
            },
            outcomia::instruction::InitializeClubPosition {},
        )
    }
}

fn market_pda(market_id: &[u8; 32]) -> Pubkey {
    pda(CLUB_PREDICTION_MARKET_SEED, &[market_id])
}
fn config(creator: &Pubkey) -> PredictionMarketConfig {
    PredictionMarketConfig {
        resolver: *creator,
        fallback: None,
        close_ts: 200,
        earliest_resolution_ts: None,
        resolution_delay_seconds: 10,
        payout_per_contract: PAYOUT,
        price_tick: 10_000,
        rules_uri: format!("ar://{}", "a".repeat(43)),
        question_hash: [1; 32],
        rules_hash: [2; 32],
    }
}

#[test]
fn club_admin_creates_a_draft_club_market_bound_to_the_club() {
    let mut f = Fixture::new();
    let admin = f.join(true);
    f.ok(
        &admin,
        f.create_market(
            &admin.pubkey(),
            MARKET_ID,
            config(&admin.pubkey()),
            ClubMarketAccess::MembersOnly,
        ),
    );
    let market = f.market();
    assert_eq!(market.status, PredictionStatus::Draft);
    assert_eq!(
        (market.authority, market.resolver, market.fallback.clone()),
        (admin.pubkey(), admin.pubkey(), None)
    );
    assert_eq!((market.yes_supply, market.backing_reserve), (0, 0));
    let binding: ClubMarket = f
        .load(&pda(CLUB_MARKET_SEED, &[market_pda(&MARKET_ID).as_ref()]))
        .unwrap();
    assert_eq!(binding.club, f.club);
    assert_eq!(binding.market, market_pda(&MARKET_ID));
    assert_eq!(binding.access, ClubMarketAccess::MembersOnly);
    assert_eq!(
        (binding.creator, binding.accrued_club_fees),
        (admin.pubkey(), 0)
    );
    let metadata: MarketMetadata = f
        .load(&pda(
            MARKET_METADATA_SEED,
            &[market_pda(&MARKET_ID).as_ref()],
        ))
        .unwrap();
    assert_eq!(
        (metadata.display_name.as_str(), metadata.kind),
        ("Will it rain?", MarketKind::Prediction)
    );
}

#[test]
fn market_creation_follows_the_club_policy() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let member = f.join(false);
    let outsider = f.wallet();
    f.fails(
        &member,
        f.create_market(
            &member.pubkey(),
            MARKET_ID,
            config(&member.pubkey()),
            ClubMarketAccess::Public,
        ),
        "UnauthorizedClubAdmin",
    );
    f.fails(
        &outsider,
        f.create_market(
            &outsider.pubkey(),
            MARKET_ID,
            config(&outsider.pubkey()),
            ClubMarketAccess::Public,
        ),
        "AccountNotInitialized",
    );
    f.ok(
        &owner,
        ix(
            outcomia::accounts::ManageClub {
                admin: owner.pubkey(),
                club: f.club,
                admin_member: f.member_pda(&owner.pubkey()),
            },
            outcomia::instruction::SetClubMarketPolicy {
                policy: ClubMarketPolicy::AnyMember,
            },
        ),
    );
    f.ok(
        &member,
        f.create_market(
            &member.pubkey(),
            MARKET_ID,
            config(&member.pubkey()),
            ClubMarketAccess::Public,
        ),
    );
}

#[test]
fn club_markets_reject_fallbacks_foreign_resolvers_and_bad_terms() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let other = Pubkey::new_unique();
    let mut c = config(&other);
    f.fails(
        &owner,
        f.create_market(
            &owner.pubkey(),
            MARKET_ID,
            c.clone(),
            ClubMarketAccess::Public,
        ),
        "InvalidClubMarket",
    );
    c = config(&owner.pubkey());
    c.fallback = Some(PredictionFallback {
        resolver: other,
        available_ts: 300,
        deadline_ts: None,
    });
    f.fails(
        &owner,
        f.create_market(&owner.pubkey(), MARKET_ID, c, ClubMarketAccess::Public),
        "InvalidClubMarket",
    );
    c = config(&owner.pubkey());
    c.payout_per_contract = 2 * PAYOUT;
    f.fails(
        &owner,
        f.create_market(&owner.pubkey(), MARKET_ID, c, ClubMarketAccess::Public),
        "InvalidPredictionPayout",
    );
    c = config(&owner.pubkey());
    c.close_ts = 100;
    assert!(f
        .send(
            &owner,
            f.create_market(&owner.pubkey(), MARKET_ID, c, ClubMarketAccess::Public)
        )
        .is_err());
}

#[test]
fn admins_or_the_creating_member_open_and_close_club_markets() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let creator = f.join(false);
    let bystander = f.join(false);
    let admin = f.join(true);
    f.ok(
        &owner,
        ix(
            outcomia::accounts::ManageClub {
                admin: owner.pubkey(),
                club: f.club,
                admin_member: f.member_pda(&owner.pubkey()),
            },
            outcomia::instruction::SetClubMarketPolicy {
                policy: ClubMarketPolicy::AnyMember,
            },
        ),
    );
    f.ok(
        &creator,
        f.create_market(
            &creator.pubkey(),
            MARKET_ID,
            config(&creator.pubkey()),
            ClubMarketAccess::MembersOnly,
        ),
    );
    f.fails(
        &bystander,
        f.manage(&bystander.pubkey(), true),
        "UnauthorizedClubAdmin",
    );
    f.ok(&creator, f.manage(&creator.pubkey(), true));
    assert_eq!(f.market().status, PredictionStatus::Open);
    f.fails(
        &creator,
        f.manage(&creator.pubkey(), true),
        "PredictionNotDraft",
    );
    // A creator who leaves loses the right; admins keep it.
    f.remove(&creator.pubkey());
    f.fails(
        &creator,
        f.manage(&creator.pubkey(), false),
        "AccountNotInitialized",
    );
    f.ok(&admin, f.manage(&admin.pubkey(), false));
    assert_eq!(f.market().status, PredictionStatus::Frozen);
    f.fails(
        &admin,
        f.manage(&admin.pubkey(), false),
        "PredictionResolutionUnavailable",
    );
}

#[test]
fn drafts_cannot_open_after_their_close_time() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    f.ok(
        &owner,
        f.create_market(
            &owner.pubkey(),
            MARKET_ID,
            config(&owner.pubkey()),
            ClubMarketAccess::Public,
        ),
    );
    f.set_clock(200);
    f.fails(
        &owner,
        f.manage(&owner.pubkey(), true),
        "PredictionOpeningClosed",
    );
}

#[test]
fn anyone_holds_a_club_position_but_public_instructions_cannot_reach_club_markets() {
    let mut f = Fixture::new();
    f.open_market(ClubMarketAccess::MembersOnly);
    let outsider = f.wallet();
    f.ok(&outsider, f.init_position(&outsider.pubkey()));
    let market = market_pda(&MARKET_ID);
    let position: PredictionPosition = f
        .load(&pda(
            PREDICTION_POSITION_SEED,
            &[market.as_ref(), outsider.pubkey().as_ref()],
        ))
        .unwrap();
    assert_eq!(
        (position.market, position.owner, position.yes_free),
        (market, outsider.pubkey(), 0)
    );

    // The public position initializer derives the public market seed.
    let other = f.wallet();
    let public_init = ix(
        outcomia::accounts::InitializePredictionPosition {
            owner: other.pubkey(),
            market,
            position: pda(
                PREDICTION_POSITION_SEED,
                &[market.as_ref(), other.pubkey().as_ref()],
            ),
            system_program: system_program::ID,
        },
        outcomia::instruction::InitializePredictionPosition {},
    );
    f.fails(&other, public_init, "ConstraintSeeds");
    // So does public resolution, even for the market's own creator.
    let owner = f.owner.insecure_clone();
    let public_freeze = ix(
        outcomia::accounts::AdvancePrediction { market },
        outcomia::instruction::AdvancePrediction { action: 0 },
    );
    f.set_clock(200);
    f.fails(&owner, public_freeze, "ConstraintSeeds");
}

#[test]
fn members_split_and_merge_with_exact_backing() {
    let mut f = Fixture::new();
    f.open_market(ClubMarketAccess::MembersOnly);
    let member = f.join(false);
    f.fund(&member, 10 * PAYOUT);
    f.ok(&member, f.complete_set(&member.pubkey(), true, 4, true));
    let p = f.position(&member.pubkey());
    assert_eq!((p.yes_free, p.no_free), (4, 4));
    let m = f.market();
    assert_eq!(
        (m.yes_supply, m.no_supply, m.backing_reserve),
        (4, 4, 4 * PAYOUT)
    );
    assert_eq!(f.token_amount(&f.market_vault()), 4 * PAYOUT);
    assert_eq!(f.free_cash(&member.pubkey()), 6 * PAYOUT);

    f.ok(&member, f.complete_set(&member.pubkey(), false, 1, false));
    assert_eq!(f.market().backing_reserve, 3 * PAYOUT);
    assert_eq!(f.token_amount(&f.market_vault()), 3 * PAYOUT);
    assert_eq!(f.free_cash(&member.pubkey()), 7 * PAYOUT);
}

#[test]
fn members_only_splits_need_current_membership_but_merges_never_do() {
    let mut f = Fixture::new();
    f.open_market(ClubMarketAccess::MembersOnly);
    let member = f.join(false);
    let outsider = f.wallet();
    f.fund(&member, 10 * PAYOUT);
    f.fund(&outsider, 10 * PAYOUT);
    f.fails(
        &outsider,
        f.complete_set(&outsider.pubkey(), false, 1, true),
        "ClubMembershipRequired",
    );
    // Another wallet's membership is not a pass.
    let mut borrowed = f.complete_set(&outsider.pubkey(), false, 1, true);
    borrowed.accounts[3] = anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        f.member_pda(&member.pubkey()),
        false,
    );
    f.fails(&outsider, borrowed, "ClubMembershipRequired");
    // Membership of a different club is not a pass either.
    let rival = f.wallet();
    let rival_club = pda(CLUB_SEED, &[&[9; 32]]);
    f.ok(
        &rival,
        ix(
            outcomia::accounts::CreateClub {
                owner: rival.pubkey(),
                club: rival_club,
                owner_member: pda(
                    CLUB_MEMBER_SEED,
                    &[rival_club.as_ref(), rival.pubkey().as_ref()],
                ),
                system_program: system_program::ID,
            },
            outcomia::instruction::CreateClub {
                club_id: [9; 32],
                name: "Rival".into(),
            },
        ),
    );
    f.fund(&rival, PAYOUT);
    let mut foreign = f.complete_set(&rival.pubkey(), false, 1, true);
    foreign.accounts[3] = anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
        pda(
            CLUB_MEMBER_SEED,
            &[rival_club.as_ref(), rival.pubkey().as_ref()],
        ),
        false,
    );
    f.fails(&rival, foreign, "ClubMembershipRequired");

    f.ok(&member, f.complete_set(&member.pubkey(), true, 3, true));
    f.remove(&member.pubkey());
    f.fails(
        &member,
        f.complete_set(&member.pubkey(), false, 1, true),
        "ClubMembershipRequired",
    );
    // The former member still exits, with no membership account at all.
    f.ok(&member, f.complete_set(&member.pubkey(), false, 3, false));
    assert_eq!(f.free_cash(&member.pubkey()), 10 * PAYOUT);
    assert_eq!(f.market().backing_reserve, 0);
}

#[test]
fn public_club_markets_let_anyone_split() {
    let mut f = Fixture::new();
    f.open_market(ClubMarketAccess::Public);
    let outsider = f.wallet();
    f.fund(&outsider, 2 * PAYOUT);
    f.ok(
        &outsider,
        f.complete_set(&outsider.pubkey(), false, 2, true),
    );
    assert_eq!(f.position(&outsider.pubkey()).yes_free, 2);
}

#[test]
fn club_splits_follow_the_market_lifecycle() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    f.ok(
        &owner,
        f.create_market(
            &owner.pubkey(),
            MARKET_ID,
            config(&owner.pubkey()),
            ClubMarketAccess::Public,
        ),
    );
    f.fund(&owner, 5 * PAYOUT);
    f.fails(
        &owner,
        f.complete_set(&owner.pubkey(), true, 1, true),
        "PredictionSplitUnavailable",
    );
    f.ok(&owner, f.manage(&owner.pubkey(), true));
    f.ok(&owner, f.complete_set(&owner.pubkey(), true, 2, true));
    f.ok(&owner, f.manage(&owner.pubkey(), false));
    f.fails(
        &owner,
        f.complete_set(&owner.pubkey(), true, 1, true),
        "PredictionSplitUnavailable",
    );
    f.ok(&owner, f.complete_set(&owner.pubkey(), true, 2, false));
}

#[test]
fn public_custody_cannot_touch_club_market_reserves() {
    let mut f = Fixture::new();
    f.open_market(ClubMarketAccess::Public);
    let owner = f.owner.insecure_clone();
    f.fund(&owner, 5 * PAYOUT);
    let c = f.custody_accounts(&owner.pubkey(), false);
    let public = ix(
        outcomia::accounts::SharedPredictionCustody {
            owner: c.owner,
            market: c.market,
            position: c.position,
            mint: c.mint,
            asset_balance: c.asset_balance,
            asset_authority: c.asset_authority,
            asset_vault: c.asset_vault,
            market_authority: c.market_authority,
            market_vault: c.market_vault,
            token_program: c.token_program,
        },
        outcomia::instruction::SharedCompleteSet {
            quantity: 1,
            split: true,
        },
    );
    f.fails(&owner, public, "ConstraintSeeds");
}

#[test]
fn any_current_club_admin_resolves_within_the_published_schedule() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let (admin, departing, member) = (f.join(true), f.join(true), f.join(false));
    let outsider = f.wallet();
    f.open_market(ClubMarketAccess::MembersOnly);
    f.fails(
        &admin,
        f.propose(&admin.pubkey(), PredictionResolution::Yes, false),
        "PredictionResolutionUnavailable",
    );

    f.set_clock(200);
    f.fails(
        &member,
        f.propose(&member.pubkey(), PredictionResolution::Yes, false),
        "UnauthorizedClubAdmin",
    );
    f.fails(
        &outsider,
        f.propose(&outsider.pubkey(), PredictionResolution::Yes, false),
        "AccountNotInitialized",
    );
    // The admin who did not create the market proposes.
    f.ok(
        &departing,
        f.propose(&departing.pubkey(), PredictionResolution::Yes, false),
    );
    let m = f.market();
    assert_eq!(m.status, PredictionStatus::Proposed);
    assert_eq!(
        m.proposal.as_ref().map(|p| (p.outcome, p.proposed_at)),
        Some((PredictionResolution::Yes, 200))
    );
    f.fails(
        &admin,
        f.propose(&admin.pubkey(), PredictionResolution::No, false),
        "PredictionProposalUnavailable",
    );

    // A removed admin loses the power at once; another admin corrects.
    f.remove(&departing.pubkey());
    f.set_clock(205);
    f.fails(
        &departing,
        f.propose(&departing.pubkey(), PredictionResolution::No, true),
        "AccountNotInitialized",
    );
    f.ok(
        &admin,
        f.propose(&admin.pubkey(), PredictionResolution::No, true),
    );
    assert_eq!(f.market().proposal.unwrap().proposed_at, 205);

    // The correction restarted the delay; nothing matures early.
    f.set_clock(214);
    f.fails(&outsider, f.advance(2), "PredictionProposalUnavailable");
    f.fails(&outsider, f.advance(1), "PredictionFallbackUnavailable");
    f.fails(&outsider, f.advance(3), "PredictionFallbackUnavailable");
    f.set_clock(215);
    f.ok(&outsider, f.advance(2));
    let m = f.market();
    assert_eq!(
        (m.status, m.final_outcome),
        (PredictionStatus::Resolved, Some(PredictionResolution::No))
    );
    f.fails(
        &owner,
        f.propose(&owner.pubkey(), PredictionResolution::Yes, true),
        "PredictionProposalUnavailable",
    );
}

#[test]
fn corrections_stop_at_the_correction_deadline() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    f.open_market(ClubMarketAccess::Public);
    // Deadline = close 200 + 2 × delay 10 = 220.
    f.set_clock(215);
    f.ok(
        &owner,
        f.propose(&owner.pubkey(), PredictionResolution::Yes, false),
    );
    f.set_clock(220);
    f.fails(
        &owner,
        f.propose(&owner.pubkey(), PredictionResolution::No, true),
        "PredictionCorrectionWindowClosed",
    );
}

#[test]
fn holders_redeem_after_resolution_whether_or_not_they_are_still_members() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let member = f.join(false);
    f.open_market(ClubMarketAccess::MembersOnly);
    f.fund(&member, 5 * PAYOUT);
    f.ok(&member, f.complete_set(&member.pubkey(), true, 5, true));
    f.fails(
        &member,
        f.redeem(&member.pubkey(), 1, 0),
        "PredictionNotResolved",
    );
    f.remove(&member.pubkey());

    f.set_clock(200);
    f.ok(
        &owner,
        f.propose(&owner.pubkey(), PredictionResolution::Yes, false),
    );
    f.set_clock(210);
    f.ok(&owner, f.advance(2));
    f.ok(&member, f.redeem(&member.pubkey(), 5, 2));
    assert_eq!(f.free_cash(&member.pubkey()), 5 * PAYOUT);
    let p = f.position(&member.pubkey());
    assert_eq!((p.yes_free, p.no_free), (0, 3));
    let m = f.market();
    assert_eq!((m.yes_supply, m.no_supply, m.backing_reserve), (0, 3, 0));
    assert_eq!(f.token_amount(&f.market_vault()), 0);
    // Nothing left to pay out: the transfer (before the ledger check) fails.
    assert!(f.send(&member, f.redeem(&member.pubkey(), 1, 0)).is_err());
}

#[test]
fn invalid_club_markets_pay_half_to_each_side() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    f.open_market(ClubMarketAccess::Public);
    f.fund(&owner, 4 * PAYOUT);
    f.ok(&owner, f.complete_set(&owner.pubkey(), true, 4, true));
    f.set_clock(200);
    f.ok(
        &owner,
        f.propose(&owner.pubkey(), PredictionResolution::Invalid, false),
    );
    f.set_clock(210);
    f.ok(&owner, f.advance(2));
    f.ok(&owner, f.redeem(&owner.pubkey(), 4, 1));
    assert_eq!(f.free_cash(&owner.pubkey()), 5 * PAYOUT / 2);
    assert_eq!(f.market().backing_reserve, 3 * PAYOUT / 2);
}

#[test]
fn club_markets_freeze_at_the_cutoff_and_the_creator_may_leave() {
    let mut f = Fixture::new();
    let owner = f.owner.insecure_clone();
    let creator = f.join(true);
    f.ok(
        &creator,
        f.create_market(
            &creator.pubkey(),
            MARKET_ID,
            config(&creator.pubkey()),
            ClubMarketAccess::Public,
        ),
    );
    f.ok(&creator, f.manage(&creator.pubkey(), true));
    f.fails(&owner, f.advance(0), "PredictionResolutionUnavailable");
    f.set_clock(200);
    f.ok(&owner, f.advance(0));
    assert_eq!(f.market().status, PredictionStatus::Frozen);
    // The stored resolver leaving does not strand the market.
    f.remove(&creator.pubkey());
    f.ok(
        &owner,
        f.propose(&owner.pubkey(), PredictionResolution::Yes, false),
    );
}

#[test]
fn club_admins_or_the_creator_initialize_the_club_book() {
    let mut f = Fixture::new();
    f.open_market(ClubMarketAccess::MembersOnly);
    let member = f.join(false);
    f.fails(
        &member,
        f.init_book(&member.pubkey()),
        "UnauthorizedClubAdmin",
    );
    let owner = f.owner.insecure_clone();
    f.ok(&owner, f.init_book(&owner.pubkey()));
    let book = f.club_book();
    assert_eq!(
        (book.market, book.kind, book.payout_per_contract),
        (market_pda(&MARKET_ID), MarketKind::Prediction, PAYOUT)
    );
    assert_eq!(
        (book.price_tick, book.quantity_lot, book.next_order_id),
        (10_000, 1, 1)
    );
    assert!(f.send(&owner, f.init_book(&owner.pubkey())).is_err());
}

#[test]
fn only_current_members_place_in_members_only_markets() {
    let mut f = Fixture::new();
    f.open_book(ClubMarketAccess::MembersOnly);
    let member = f.join(false);
    let outsider = f.wallet();
    f.fund(&member, 10 * PAYOUT);
    f.fund(&outsider, 10 * PAYOUT);
    f.fails(
        &outsider,
        f.place(&outsider.pubkey(), false, Yes, Bid, 400_000, 2, 1),
        "ClubMembershipRequired",
    );
    f.ok(
        &member,
        f.place(&member.pubkey(), true, Yes, Bid, 400_000, 2, 1),
    );
    assert_eq!(f.locked_cash(&member.pubkey()), 800_000);
    assert_eq!(f.club_book().best_prices[0], Some(400_000));
    f.remove(&member.pubkey());
    f.fails(
        &member,
        f.place(&member.pubkey(), false, No, Bid, 300_000, 1, 2),
        "ClubMembershipRequired",
    );
}

#[test]
fn anyone_places_in_public_club_markets() {
    let mut f = Fixture::new();
    f.open_book(ClubMarketAccess::Public);
    let outsider = f.wallet();
    f.fund(&outsider, 10 * PAYOUT);
    f.ok(
        &outsider,
        f.place(&outsider.pubkey(), false, No, Bid, 300_000, 3, 1),
    );
    assert_eq!(f.locked_cash(&outsider.pubkey()), 900_000);
}

#[test]
fn a_removed_members_orders_can_be_cancelled_by_anyone_for_the_owner() {
    let mut f = Fixture::new();
    f.open_book(ClubMarketAccess::MembersOnly);
    let (member, other) = (f.join(false), f.join(false));
    let stranger = f.wallet();
    f.fund(&member, 10 * PAYOUT);
    f.ok(
        &member,
        f.place(&member.pubkey(), true, Yes, Bid, 400_000, 2, 1),
    );
    f.ok(&member, f.complete_set(&member.pubkey(), true, 2, true));
    f.ok(
        &member,
        f.place(&member.pubkey(), true, No, Ask, 700_000, 2, 2),
    );
    // While the owner is a member, only the owner cancels.
    f.fails(
        &stranger,
        f.cancel(&stranger.pubkey(), 1),
        "UnauthorizedSharedOrderOwner",
    );
    f.fails(
        &other,
        f.cancel(&other.pubkey(), 1),
        "UnauthorizedSharedOrderOwner",
    );

    f.remove(&member.pubkey());
    let rent_before = f.lamports(&member.pubkey());
    f.ok(&stranger, f.cancel(&stranger.pubkey(), 1));
    f.ok(&stranger, f.cancel(&stranger.pubkey(), 2));
    // Cash, contracts and level rent all return to the former member.
    assert_eq!(f.locked_cash(&member.pubkey()), 0);
    assert_eq!(f.free_cash(&member.pubkey()), 8 * PAYOUT);
    let p = f.position(&member.pubkey());
    assert_eq!((p.no_free, p.no_locked), (2, 0));
    assert!(f.lamports(&member.pubkey()) > rent_before);
    let book = f.club_book();
    assert_eq!((book.open_order_count, book.best_prices), (0, [None; 4]));
}

#[test]
fn owners_always_cancel_and_strangers_never_in_public_markets() {
    let mut f = Fixture::new();
    f.open_book(ClubMarketAccess::Public);
    let (trader, stranger) = (f.wallet(), f.wallet());
    f.fund(&trader, 2 * PAYOUT);
    f.ok(
        &trader,
        f.place(&trader.pubkey(), false, Yes, Bid, 500_000, 2, 1),
    );
    f.ok(
        &trader,
        f.place(&trader.pubkey(), false, No, Bid, 200_000, 1, 2),
    );
    // Not a member, but the market is public: the order is not abandoned.
    f.fails(
        &stranger,
        f.cancel(&stranger.pubkey(), 1),
        "UnauthorizedSharedOrderOwner",
    );
    f.ok(&trader, f.cancel(&trader.pubkey(), 1));
    // Exits survive the end of trading.
    f.set_clock(200);
    f.ok(&trader, f.cancel(&trader.pubkey(), 2));
    assert_eq!(f.free_cash(&trader.pubkey()), 2 * PAYOUT);
}

#[test]
fn public_trading_instructions_cannot_use_club_books() {
    let mut f = Fixture::new();
    f.open_book(ClubMarketAccess::Public);
    let trader = f.wallet();
    f.fund(&trader, 2 * PAYOUT);
    let market = market_pda(&MARKET_ID);
    let public = ix(
        outcomia::accounts::PlaceSharedOrder {
            owner: trader.pubkey(),
            market,
            book: f.book(),
            base_balance: None,
            quote_balance: f.balance_pda(&trader.pubkey()),
            position: Some(pda(
                PREDICTION_POSITION_SEED,
                &[market.as_ref(), trader.pubkey().as_ref()],
            )),
            order: f.order_pda(1),
            price_level: f.level_pda(Yes, Bid, 500_000),
            tail: None,
            better_level: None,
            worse_level: None,
            system_program: system_program::ID,
        },
        outcomia::instruction::PlaceSharedOrder {
            outcome: Yes,
            side: Bid,
            price: 500_000,
            quantity: 1,
            order_id: 1,
        },
    );
    f.fails(&trader, public, "ConstraintSeeds");
}

#[test]
fn member_fills_split_the_taker_fee_with_the_club() {
    let mut f = Fixture::new();
    f.set_fees(100, Some(2_500));
    f.open_book(ClubMarketAccess::MembersOnly);
    let (maker, taker) = (f.join(false), f.join(false));
    f.fund(&maker, 10 * PAYOUT);
    f.fund(&taker, 10 * PAYOUT);
    f.ok(&maker, f.complete_set(&maker.pubkey(), true, 2, true));
    f.ok(
        &maker,
        f.place(&maker.pubkey(), true, Yes, Ask, 600_000, 2, 1),
    );
    f.ok(
        &taker,
        f.take(&taker.pubkey(), true, true, 1, Yes, Bid, 600_000, 2, false),
    );
    // Notional 1.2 at 1%: fee 12,000, of which 25% (3,000) goes to the club.
    assert_eq!(f.free_cash(&taker.pubkey()), 10 * PAYOUT - 1_212_000);
    assert_eq!(f.free_cash(&maker.pubkey()), 8 * PAYOUT + 1_200_000);
    assert_eq!(f.position(&taker.pubkey()).yes_free, 2);
    assert_eq!(f.club_book().accrued_quote_fees, 9_000);
    assert_eq!(f.club_market().accrued_club_fees, 3_000);
    assert_eq!(f.vault_surplus(&[&maker.pubkey(), &taker.pubkey()]), 0);
}

#[test]
fn removed_or_outside_parties_cannot_fill_in_members_only_markets() {
    let mut f = Fixture::new();
    f.set_fees(0, None);
    f.open_book(ClubMarketAccess::MembersOnly);
    let (maker, taker) = (f.join(false), f.join(false));
    let outsider = f.wallet();
    for w in [&maker, &taker, &outsider] {
        f.fund(w, 10 * PAYOUT);
    }
    f.ok(
        &maker,
        f.place(&maker.pubkey(), true, No, Bid, 400_000, 3, 1),
    );
    f.ok(&taker, f.complete_set(&taker.pubkey(), true, 3, true));
    f.fails(
        &outsider,
        f.take(
            &outsider.pubkey(),
            false,
            true,
            1,
            No,
            Ask,
            400_000,
            1,
            false,
        ),
        "ClubMembershipRequired",
    );
    // Omitting the maker's membership is not a way around the check.
    f.fails(
        &taker,
        f.take(&taker.pubkey(), true, false, 1, No, Ask, 400_000, 1, false),
        "ClubMembershipRequired",
    );
    f.remove(&maker.pubkey());
    f.fails(
        &taker,
        f.take(&taker.pubkey(), true, false, 1, No, Ask, 400_000, 1, false),
        "ClubMembershipRequired",
    );
    f.fails(
        &taker,
        f.take(&taker.pubkey(), true, false, 1, Yes, Bid, 600_000, 1, true),
        "ClubMembershipRequired",
    );
    // The blocked head is cleared by anyone and the book moves on.
    f.ok(&outsider, f.cancel(&outsider.pubkey(), 1));
    assert_eq!(f.club_book().best_prices[2], None);
}

#[test]
fn complementary_club_fills_mint_and_merge_with_the_fee_split() {
    let mut f = Fixture::new();
    f.set_fees(100, Some(5_000));
    f.open_book(ClubMarketAccess::MembersOnly);
    let (a, b) = (f.join(false), f.join(true));
    f.fund(&a, 10 * PAYOUT);
    f.fund(&b, 10 * PAYOUT);
    // Mint: a NO bid at 0.40 and a YES buyer at 0.60 create three pairs.
    f.ok(&a, f.place(&a.pubkey(), true, No, Bid, 400_000, 3, 1));
    f.ok(
        &b,
        f.take(&b.pubkey(), true, true, 1, Yes, Bid, 600_000, 3, true),
    );
    let m = f.market();
    assert_eq!(
        (m.yes_supply, m.no_supply, m.backing_reserve),
        (3, 3, 3 * PAYOUT)
    );
    assert_eq!(f.token_amount(&f.market_vault()), 3 * PAYOUT);
    // Taker notional 1.8 at 1%: 18,000 fee, half to the club.
    assert_eq!(f.club_market().accrued_club_fees, 9_000);
    assert_eq!(f.club_book().accrued_quote_fees, 9_000);
    assert_eq!(f.free_cash(&b.pubkey()), 10 * PAYOUT - 1_818_000);
    assert_eq!(
        (
            f.position(&a.pubkey()).no_free,
            f.position(&b.pubkey()).yes_free
        ),
        (3, 3)
    );

    // Merge: a sells NO at 0.45 resting, b sells YES at 0.55 into it.
    f.ok(&a, f.place(&a.pubkey(), true, No, Ask, 450_000, 3, 2));
    f.ok(
        &b,
        f.take(&b.pubkey(), true, true, 2, Yes, Ask, 550_000, 3, true),
    );
    let m = f.market();
    assert_eq!((m.yes_supply, m.backing_reserve), (0, 0));
    assert_eq!(f.token_amount(&f.market_vault()), 0);
    assert_eq!(f.club_market().accrued_club_fees, 9_000 + 8_250);
    assert_eq!(f.vault_surplus(&[&a.pubkey(), &b.pubkey()]), 0);
}

#[test]
fn without_a_fee_config_the_whole_fee_stays_with_the_book() {
    let mut f = Fixture::new();
    f.set_fees(100, None);
    f.open_book(ClubMarketAccess::Public);
    let (maker, taker) = (f.wallet(), f.wallet());
    f.fund(&maker, 10 * PAYOUT);
    f.fund(&taker, 10 * PAYOUT);
    f.ok(
        &maker,
        f.place(&maker.pubkey(), false, Yes, Bid, 500_000, 2, 1),
    );
    f.ok(&taker, f.complete_set(&taker.pubkey(), false, 2, true));
    // Anyone trades in a public club market.
    f.ok(
        &taker,
        f.take(
            &taker.pubkey(),
            false,
            false,
            1,
            Yes,
            Ask,
            500_000,
            2,
            false,
        ),
    );
    assert_eq!(f.club_book().accrued_quote_fees, 10_000);
    assert_eq!(f.club_market().accrued_club_fees, 0);
    assert_eq!(f.vault_surplus(&[&maker.pubkey(), &taker.pubkey()]), 0);
}

#[test]
fn club_fills_stop_when_trading_closes() {
    let mut f = Fixture::new();
    f.set_fees(0, None);
    f.open_book(ClubMarketAccess::Public);
    let (maker, taker) = (f.wallet(), f.wallet());
    f.fund(&maker, 2 * PAYOUT);
    f.fund(&taker, 2 * PAYOUT);
    f.ok(
        &maker,
        f.place(&maker.pubkey(), false, Yes, Bid, 500_000, 1, 1),
    );
    f.ok(&taker, f.complete_set(&taker.pubkey(), false, 1, true));
    let owner = f.owner.insecure_clone();
    f.ok(&owner, f.manage(&owner.pubkey(), false));
    f.fails(
        &taker,
        f.take(
            &taker.pubkey(),
            false,
            false,
            1,
            Yes,
            Ask,
            500_000,
            1,
            false,
        ),
        "PredictionOrderUnavailable",
    );
}

#[test]
fn the_club_owner_and_the_super_admin_each_withdraw_only_their_fee_share() {
    let mut f = Fixture::new();
    let super_admin = f.wallet();
    f.set_fees_with_admin(100, Some(2_500), super_admin.pubkey());
    f.open_book(ClubMarketAccess::MembersOnly);
    let owner = f.owner.insecure_clone();
    let (maker, taker) = (f.join(true), f.join(false));
    f.fund(&maker, 10 * PAYOUT);
    f.fund(&taker, 10 * PAYOUT);
    f.ok(&maker, f.complete_set(&maker.pubkey(), true, 2, true));
    f.ok(
        &maker,
        f.place(&maker.pubkey(), true, Yes, Ask, 600_000, 2, 1),
    );
    f.ok(
        &taker,
        f.take(&taker.pubkey(), true, true, 1, Yes, Bid, 600_000, 2, false),
    );
    let wallets = [&maker.pubkey(), &taker.pubkey()];

    let owner_token = f.token_account(&owner.pubkey(), 0);
    let admin_token = f.token_account(&maker.pubkey(), 0);
    // A club admin is not the owner; the super-admin has no club share.
    f.fails(
        &maker,
        f.withdraw_club(&maker.pubkey(), admin_token, 1),
        "UnauthorizedClubOwner",
    );
    f.fails(
        &owner,
        f.withdraw_book(&owner.pubkey(), owner_token, 1),
        "UnauthorizedAdmin",
    );
    f.fails(
        &owner,
        f.withdraw_club(&owner.pubkey(), owner_token, 3_001),
        "InsufficientFreeBalance",
    );
    f.fails(
        &owner,
        f.withdraw_club(&owner.pubkey(), owner_token, 0),
        "InvalidWithdrawalAmount",
    );

    f.ok(&owner, f.withdraw_club(&owner.pubkey(), owner_token, 3_000));
    assert_eq!(f.token_amount(&owner_token), 3_000);
    assert_eq!(f.club_market().accrued_club_fees, 0);
    assert_eq!(f.vault_surplus(&wallets), 0);

    let protocol_token = f.token_account(&super_admin.pubkey(), 0);
    f.fails(
        &super_admin,
        f.withdraw_book(&super_admin.pubkey(), protocol_token, 9_001),
        "InsufficientFreeBalance",
    );
    f.ok(
        &super_admin,
        f.withdraw_book(&super_admin.pubkey(), protocol_token, 9_000),
    );
    assert_eq!(f.token_amount(&protocol_token), 9_000);
    assert_eq!(f.club_book().accrued_quote_fees, 0);
    assert_eq!(f.vault_surplus(&wallets), 0);
}
