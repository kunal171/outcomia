//! Club fixture shared by the deposit and lifecycle tests: protocol config,
//! club rules, a 6-decimal mint, Pyth price accounts and club instructions.
#![allow(dead_code, unused_imports)]

pub use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack, system_program},
    AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas,
};
pub use anchor_spl::token::spl_token::state::{Account as TokenState, AccountState, Mint};
pub use litesvm::LiteSVM;
pub use outcomia::{
    constants::*, instructions::ClubDepositRules, prediction_config::PredictionMarketConfig,
    state::*,
};
pub use pyth_solana_receiver_sdk::price_update::{
    PriceFeedMessage, PriceUpdateV2, VerificationLevel,
};
pub use solana_account::Account;
pub use solana_keypair::Keypair;
pub use solana_message::{Message, VersionedMessage};
pub use solana_signer::Signer;
pub use solana_transaction::versioned::VersionedTransaction;

pub const PROGRAM_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/deploy/outcomia.so"
));
pub const FEED: [u8; 32] = [9; 32];
pub const NOW: i64 = 1_000;
pub const SOL: u64 = 1_000_000_000;
/// $150.00000000 with exponent -8.
pub const PRICE_150: i64 = 15_000_000_000;

pub fn pda(parts: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(parts, &outcomia::ID).0
}
pub fn rules_pda() -> Pubkey {
    pda(&[CLUB_RULES_CONFIG_SEED])
}
pub fn club_pda(id: u8) -> Pubkey {
    pda(&[CLUB_SEED, &[id; 32]])
}
pub fn member_pda(club: &Pubkey, wallet: &Pubkey) -> Pubkey {
    pda(&[CLUB_MEMBER_SEED, club.as_ref(), wallet.as_ref()])
}
pub fn vault_pda(club: &Pubkey) -> Pubkey {
    pda(&[CLUB_DEPOSIT_VAULT_SEED, club.as_ref()])
}
pub fn market_pda(id: &[u8; 32]) -> Pubkey {
    pda(&[CLUB_PREDICTION_MARKET_SEED, id])
}
pub fn ix(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction::new_with_bytes(outcomia::ID, &data.data(), accounts.to_account_metas(None))
}
pub fn deposit_rules() -> ClubDepositRules {
    ClubDepositRules {
        private_min_deposit_usd: 100_000_000,
        public_min_deposit_usd: 200_000_000,
        sol_buffer_bps: 12_000,
        sol_usd_feed_id: FEED,
        max_price_age_seconds: 60,
        max_price_conf_bps: 100,
    }
}

pub struct Fixture {
    pub svm: LiteSVM,
    pub super_admin: Keypair,
    pub owner: Keypair,
    pub mint: Pubkey,
}

impl Fixture {
    /// Protocol config, club rules (no deposit rules yet), a 6-decimal mint
    /// and a funded owner.
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(outcomia::ID, PROGRAM_BYTES).unwrap();
        let super_admin = Keypair::new();
        let owner = Keypair::new();
        svm.airdrop(&super_admin.pubkey(), 10 * SOL).unwrap();
        svm.airdrop(&owner.pubkey(), 20 * SOL).unwrap();
        let mint = Pubkey::new_unique();
        let mut f = Fixture {
            svm,
            super_admin,
            owner,
            mint,
        };
        let mut data = vec![0; Mint::LEN];
        Mint::pack(
            Mint {
                mint_authority: Some(f.owner.pubkey()).into(),
                supply: 1_000_000_000_000,
                decimals: 6,
                is_initialized: true,
                freeze_authority: None.into(),
            },
            &mut data,
        )
        .unwrap();
        f.store(mint, data, anchor_spl::token::ID);
        let (address, bump) = Pubkey::find_program_address(&[PROTOCOL_CONFIG_SEED], &outcomia::ID);
        let mut data = Vec::new();
        ProtocolConfig {
            super_admin: f.super_admin.pubkey(),
            taker_fee_bps: 0,
            bump,
        }
        .try_serialize(&mut data)
        .unwrap();
        f.store(address, data, outcomia::ID);
        let sa = f.super_admin.insecure_clone();
        f.ok(
            &sa,
            ix(
                outcomia::accounts::SetClubRules {
                    super_admin: sa.pubkey(),
                    protocol_config: pda(&[PROTOCOL_CONFIG_SEED]),
                    club_rules: rules_pda(),
                    system_program: system_program::ID,
                },
                outcomia::instruction::SetClubRules {
                    public_member_cap: 100,
                    private_member_cap: 10,
                    max_owned_clubs: 5,
                    max_club_admins: 5,
                },
            ),
        );
        f.set_clock(NOW);
        f
    }
    pub fn store(&mut self, address: Pubkey, data: Vec<u8>, owner: Pubkey) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                address,
                Account {
                    lamports,
                    data,
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }
    pub fn set_clock(&mut self, now: i64) {
        let mut c = self.svm.get_sysvar::<Clock>();
        c.unix_timestamp = now;
        self.svm.set_sysvar(&c);
    }
    pub fn send(&mut self, signer: &Keypair, ix: Instruction) -> Result<(), Vec<String>> {
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
    pub fn ok(&mut self, signer: &Keypair, ix: Instruction) {
        if let Err(logs) = self.send(signer, ix) {
            panic!("transaction should succeed: {logs:#?}");
        }
    }
    pub fn fails(&mut self, signer: &Keypair, ix: Instruction, error: &str) {
        let logs = self.send(signer, ix).expect_err("transaction should fail");
        let needle = format!("Error Code: {error}.");
        assert!(
            logs.iter().any(|l| l.contains(&needle)),
            "expected {error}: {logs:#?}"
        );
    }
    pub fn load<T: AccountDeserialize>(&self, address: &Pubkey) -> T {
        let account = self.svm.get_account(address).unwrap();
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }
    pub fn club(&self, id: u8) -> Club {
        self.load(&club_pda(id))
    }
    pub fn set_deposit_rules(&self, signer: &Pubkey, rules: ClubDepositRules) -> Instruction {
        ix(
            outcomia::accounts::SetClubDepositRules {
                super_admin: *signer,
                protocol_config: pda(&[PROTOCOL_CONFIG_SEED]),
                club_rules: rules_pda(),
                deposit_mint: self.mint,
            },
            outcomia::instruction::SetClubDepositRules { rules },
        )
    }
    pub fn configure(&mut self) {
        let sa = self.super_admin.insecure_clone();
        self.ok(&sa, self.set_deposit_rules(&sa.pubkey(), deposit_rules()));
    }
    pub fn create_club(&mut self, id: u8, kind: ClubKind) -> Pubkey {
        let owner = self.owner.insecure_clone();
        let club = club_pda(id);
        self.ok(
            &owner,
            ix(
                outcomia::accounts::CreateClub {
                    owner: owner.pubkey(),
                    club_rules: rules_pda(),
                    owner_record: pda(&[CLUB_OWNER_SEED, owner.pubkey().as_ref()]),
                    club,
                    owner_member: member_pda(&club, &owner.pubkey()),
                    system_program: system_program::ID,
                },
                outcomia::instruction::CreateClub {
                    club_id: [id; 32],
                    name: format!("Club {id}"),
                    kind,
                },
            ),
        );
        club
    }
    /// A token account of the deposit mint owned by `owner`.
    pub fn token_account(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let token = Pubkey::new_unique();
        let mut data = vec![0; TokenState::LEN];
        TokenState::pack(
            TokenState {
                mint: self.mint,
                owner: *owner,
                amount,
                delegate: None.into(),
                state: AccountState::Initialized,
                is_native: None.into(),
                delegated_amount: 0,
                close_authority: None.into(),
            },
            &mut data,
        )
        .unwrap();
        self.store(token, data, anchor_spl::token::ID);
        token
    }
    pub fn token_amount(&self, address: &Pubkey) -> u64 {
        let account = self.svm.get_account(address).unwrap();
        TokenState::unpack(&account.data).unwrap().amount
    }
    pub fn deposit_usdc(
        &self,
        owner: &Pubkey,
        club: Pubkey,
        token: Pubkey,
        amount: u64,
    ) -> Instruction {
        ix(
            outcomia::accounts::DepositClubUsdc {
                owner: *owner,
                club,
                club_rules: rules_pda(),
                deposit_mint: self.mint,
                owner_token: token,
                deposit_vault: vault_pda(&club),
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            },
            outcomia::instruction::DepositClubUsdc { amount },
        )
    }
    pub fn deposit_sol(
        &self,
        owner: &Pubkey,
        club: Pubkey,
        price: Pubkey,
        lamports: u64,
    ) -> Instruction {
        ix(
            outcomia::accounts::DepositClubSol {
                owner: *owner,
                club,
                club_rules: rules_pda(),
                price_update: price,
                system_program: system_program::ID,
            },
            outcomia::instruction::DepositClubSol { lamports },
        )
    }
    /// Writes a Pyth price account, owned by the Pyth receiver program.
    pub fn price_account(&mut self, edit: impl FnOnce(&mut PriceUpdateV2)) -> Pubkey {
        let mut update = PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: VerificationLevel::Full,
            price_message: PriceFeedMessage {
                feed_id: FEED,
                price: PRICE_150,
                conf: 1_000_000,
                exponent: -8,
                publish_time: NOW - 5,
                prev_publish_time: NOW - 6,
                ema_price: PRICE_150,
                ema_conf: 1_000_000,
            },
            posted_slot: 1,
        };
        edit(&mut update);
        let mut data = Vec::new();
        update.try_serialize(&mut data).unwrap();
        let address = Pubkey::new_unique();
        self.store(address, data, pyth_solana_receiver_sdk::ID);
        address
    }
    pub fn fund_usdc(&mut self, club: Pubkey, amount: u64) {
        let owner = self.owner.insecure_clone();
        let token = self.token_account(&owner.pubkey(), amount);
        self.ok(
            &owner,
            self.deposit_usdc(&owner.pubkey(), club, token, amount),
        );
    }
    pub fn create_market(&self, club: Pubkey, id: u8, price: Option<Pubkey>) -> Instruction {
        let creator = self.owner.pubkey();
        let market = market_pda(&[id; 32]);
        ix(
            outcomia::accounts::CreateClubPredictionMarket {
                creator,
                club,
                creator_member: member_pda(&club, &creator),
                market,
                club_market: pda(&[CLUB_MARKET_SEED, market.as_ref()]),
                collateral_mint: self.mint,
                vault_authority: pda(&[VAULT_AUTHORITY_SEED, market.as_ref()]),
                collateral_vault: pda(&[VAULT_SEED, market.as_ref(), self.mint.as_ref()]),
                market_metadata: pda(&[MARKET_METADATA_SEED, market.as_ref()]),
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
                club_rules: rules_pda(),
                price_update: price,
            },
            outcomia::instruction::CreateClubPredictionMarket {
                market_id: [id; 32],
                config: PredictionMarketConfig {
                    resolver: creator,
                    fallback: None,
                    close_ts: NOW + 10_000,
                    earliest_resolution_ts: None,
                    resolution_delay_seconds: 10,
                    payout_per_contract: 1_000_000,
                    price_tick: 10_000,
                    rules_uri: format!("ar://{}", "a".repeat(43)),
                    question_hash: [1; 32],
                    rules_hash: [2; 32],
                },
                display_name: "Will it rain?".into(),
                collateral_symbol: "USDC".into(),
                access: ClubMarketAccess::MembersOnly,
            },
        )
    }
    pub fn open_market(&self, club: Pubkey, id: u8, price: Option<Pubkey>) -> Instruction {
        let market = market_pda(&[id; 32]);
        ix(
            outcomia::accounts::OpenClubPredictionMarket {
                actor: self.owner.pubkey(),
                club_market: pda(&[CLUB_MARKET_SEED, market.as_ref()]),
                market,
                actor_member: member_pda(&club, &self.owner.pubkey()),
                club,
                club_rules: rules_pda(),
                price_update: price,
            },
            outcomia::instruction::OpenClubPredictionMarket {},
        )
    }
    pub fn set_live_markets(&self, signer: &Pubkey, club: Pubkey, count: u32) -> Instruction {
        ix(
            outcomia::accounts::SetClubLiveMarkets {
                super_admin: *signer,
                protocol_config: pda(&[PROTOCOL_CONFIG_SEED]),
                club,
            },
            outcomia::instruction::SetClubLiveMarkets { count },
        )
    }
}
