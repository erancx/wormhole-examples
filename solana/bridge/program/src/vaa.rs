use crate::{
    api::post_vaa::PostVAAData,
    error::Error::{
        InvalidGovernanceAction,
        InvalidGovernanceChain,
        InvalidGovernanceModule,
        VAAAlreadyExecuted,
    },
    Claim,
    ClaimDerivationData,
    PostedVAAData,
    Result,
    CHAIN_ID_SOLANA,
};
use byteorder::{
    BigEndian,
    ReadBytesExt,
};
use solana_program::pubkey::Pubkey;
use solitaire::{
    processors::seeded::Seeded,
    trace,
    Context,
    CreationLamports::Exempt,
    Data,
    ExecutionContext,
    Peel,
    SolitaireError,
    *,
};
use std::{
    io::{
        Cursor,
        Read,
        Write,
    },
    ops::Deref,
};
use wormhole_core::VAA;

pub trait SerializePayload: Sized {
    fn serialize<W: Write>(&self, writer: &mut W) -> std::result::Result<(), SolitaireError>;

    fn try_to_vec(&self) -> std::result::Result<Vec<u8>, SolitaireError> {
        let mut result = Vec::with_capacity(256);
        self.serialize(&mut result)?;
        Ok(result)
    }
}

pub trait DeserializePayload: Sized {
    fn deserialize(buf: &mut &[u8]) -> std::result::Result<Self, SolitaireError>;
}

pub trait SerializeGovernancePayload: SerializePayload {
    const MODULE: &'static str;
    const ACTION: u8;

    fn try_to_vec(&self) -> std::result::Result<Vec<u8>, SolitaireError> {
        let mut result = Vec::with_capacity(256);
        self.write_governance_header(&mut result)?;
        self.serialize(&mut result)?;
        Ok(result)
    }

    fn write_governance_header<W: Write>(
        &self,
        c: &mut W,
    ) -> std::result::Result<(), SolitaireError> {
        use byteorder::WriteBytesExt;
        let module = format!("{:\0>32}", Self::MODULE);
        let module = module.as_bytes();
        c.write(&module)?;
        c.write_u8(Self::ACTION)?;
        c.write_u16::<BigEndian>(CHAIN_ID_SOLANA)?;
        Ok(())
    }
}

pub trait DeserializeGovernancePayload: DeserializePayload + SerializeGovernancePayload {
    fn check_governance_header(
        c: &mut Cursor<&mut &[u8]>,
    ) -> std::result::Result<(), SolitaireError> {
        let mut module = [0u8; 32];
        c.read_exact(&mut module)?;
        if module != format!("{:\0>32}", Self::MODULE).as_bytes() {
            return Err(InvalidGovernanceModule.into());
        }

        let action = c.read_u8()?;
        if action != Self::ACTION {
            return Err(InvalidGovernanceAction.into());
        }

        let chain = c.read_u16::<BigEndian>()?;
        if chain != CHAIN_ID_SOLANA && chain != 0 {
            return Err(InvalidGovernanceChain.into());
        }

        Ok(())
    }
}

pub struct PayloadMessage<'b, T: DeserializePayload>(
    Data<'b, PostedVAAData, { AccountState::Initialized }>,
    T,
);

impl<'a, 'b: 'a, 'c, T: DeserializePayload> Peel<'a, 'b, 'c> for PayloadMessage<'b, T> {
    fn peel<I>(ctx: &'c mut Context<'a, 'b, 'c, I>) -> Result<Self>
    where
        Self: Sized,
    {
        // Deserialize wrapped payload
        let data: Data<'b, PostedVAAData, { AccountState::Initialized }> = Data::peel(ctx)?;
        let payload = DeserializePayload::deserialize(&mut &data.payload[..])?;
        Ok(PayloadMessage(data, payload))
    }

    fn deps() -> Vec<Pubkey> {
        Data::<'b, PostedVAAData, { AccountState::Initialized }>::deps()
    }

    fn persist(&self, program_id: &Pubkey) -> Result<()> {
        Data::persist(&self.0, program_id)
    }
}

impl<'b, T: DeserializePayload> Deref for PayloadMessage<'b, T> {
    type Target = T;
    fn deref(&self) -> &Self::Target {
        &self.1
    }
}

impl<'b, T: DeserializePayload> PayloadMessage<'b, T> {
    pub fn meta(&self) -> &PostedVAAData {
        &self.0
    }
}

#[derive(FromAccounts)]
pub struct ClaimableVAA<'b, T: DeserializePayload> {
    // Signed message for the transfer
    pub message: PayloadMessage<'b, T>,

    // Claim account to prevent double spending
    pub claim: Mut<Claim<'b, { AccountState::Uninitialized }>>,
}

impl<'b, T: DeserializePayload> Deref for ClaimableVAA<'b, T> {
    type Target = PayloadMessage<'b, T>;
    fn deref(&self) -> &Self::Target {
        &self.message
    }
}

impl<'b, T: DeserializePayload> ClaimableVAA<'b, T> {
    pub fn verify(&self, program_id: &Pubkey) -> Result<()> {
        trace!("Seq: {}", self.message.meta().sequence);

        // Verify that the claim account is derived correctly
        self.claim.verify_derivation(
            program_id,
            &ClaimDerivationData {
                emitter_address: self.message.meta().emitter_address,
                emitter_chain: self.message.meta().emitter_chain,
                sequence: self.message.meta().sequence,
            },
        )?;

        Ok(())
    }
}

impl<'b, T: DeserializePayload> ClaimableVAA<'b, T> {
    pub fn is_claimed(&self) -> bool {
        self.claim.claimed
    }

    pub fn claim(&mut self, ctx: &ExecutionContext, payer: &Pubkey) -> Result<()> {
        if self.is_claimed() {
            return Err(VAAAlreadyExecuted.into());
        }

        self.claim.create(
            &ClaimDerivationData {
                emitter_address: self.message.meta().emitter_address,
                emitter_chain: self.message.meta().emitter_chain,
                sequence: self.message.meta().sequence,
            },
            ctx,
            payer,
            Exempt,
        )?;

        self.claim.claimed = true;

        Ok(())
    }
}

pub struct SignatureItem {
    pub signature: Vec<u8>,
    pub key: [u8; 20],
    pub index: u8,
}

impl From<VAA> for PostVAAData {
    fn from(vaa: VAA) -> Self {
        PostVAAData {
            version: vaa.version,
            guardian_set_index: vaa.guardian_set_index,
            timestamp: vaa.timestamp,
            nonce: vaa.nonce,
            emitter_chain: vaa.emitter_chain as u16,
            emitter_address: vaa.emitter_address,
            sequence: vaa.sequence,
            consistency_level: vaa.consistency_level,
            payload: vaa.payload,
        }
    }
}
