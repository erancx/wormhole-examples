import {
  ChainId,
  CHAIN_ID_BSC,
  CHAIN_ID_ETH,
  CHAIN_ID_SOLANA,
  createNonce,
  getBridgeFeeIx,
  getEmitterAddressEth,
  getEmitterAddressSolana,
  hexToNativeString,
  ixFromRust,
  parseSequenceFromLogEth,
  parseSequenceFromLogSolana,
} from "@certusone/wormhole-sdk";
import { uint8ArrayToNative } from "@certusone/wormhole-sdk/lib/esm";
import getSignedVAAWithRetry from "@certusone/wormhole-sdk/lib/esm/rpc/getSignedVAAWithRetry";
import { importCoreWasm } from "@certusone/wormhole-sdk/lib/esm/solana/wasm";
import { hexlify, hexStripZeros } from "@ethersproject/bytes";
import { Web3Provider } from "@ethersproject/providers";
import {
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  CardHeader,
  List,
  ListItem,
  ListItemText,
  TextField,
  Typography,
} from "@mui/material";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { useSnackbar } from "notistack";
import React, { useCallback, useState } from "react";
import { useEthereumProvider } from "./contexts/EthereumProviderContext";
import { useSolanaWallet } from "./contexts/SolanaWalletContext";
import { address as ETH_CONTRACT_ADDRESS } from "./contract-addresses/development";
import { address as BSC_CONTRACT_ADDRESS } from "./contract-addresses/development2";
import { Messenger__factory } from "./ethers-contracts";

interface ParsedVaa {
  consistency_level: number;
  emitter_address: Uint8Array;
  emitter_chain: ChainId;
  guardian_set_index: number;
  nonce: number;
  payload: Uint8Array;
  sequence: number;
  signatures: any;
  timestamp: number;
  version: number;
}

const SOLANA_BRIDGE_ADDRESS = "Bridge1p5gheXUvJ6jGWGeCsgPKgnE3YgdGKRVCMY9o";
const SOLANA_PROGRAM = require("./contract-addresses/solana.json").programId;
const SOLANA_HOST = "http://localhost:8899";
const WORMHOLE_RPC_HOSTS = ["http://localhost:7071"];

const chainToNetworkDec = (c: ChainId) => (c === 2 ? 1337 : c === 4 ? 1397 : 0);

const chainToNetwork = (c: ChainId) =>
  hexStripZeros(hexlify(chainToNetworkDec(c)));

const chainToContract = (c: ChainId) =>
  c === 2 ? ETH_CONTRACT_ADDRESS : c === 4 ? BSC_CONTRACT_ADDRESS : "";

const chainToName = (c: ChainId) =>
  c === 1 ? "Solana" : c === 2 ? "Ethereum" : c === 4 ? "BSC" : "Unknown";

const MM_ERR_WITH_INFO_START =
  "VM Exception while processing transaction: revert ";
const parseError = (e: any) =>
  e?.data?.message?.startsWith(MM_ERR_WITH_INFO_START)
    ? e.data.message.replace(MM_ERR_WITH_INFO_START, "")
    : e?.response?.data?.error // terra error
    ? e.response.data.error
    : e?.message
    ? e.message
    : "An unknown error occurred";

const switchProviderNetwork = async (
  provider: Web3Provider,
  chainId: ChainId
) => {
  await provider.send("wallet_switchEthereumChain", [
    { chainId: chainToNetwork(chainId) },
  ]);
  const cNetwork = await provider.getNetwork();
  // This is workaround for when Metamask fails to switch network.
  if (cNetwork.chainId !== chainToNetworkDec(chainId)) {
    console.log("switchProviderNetwork did not work");
    throw new Error("Metamask could not switch network");
  }
};

function Chain({
  name,
  value,
  onChange,
  onClick,
  disabled,
}: {
  name: string;
  value: string;
  onChange: any;
  onClick: any;
  disabled?: boolean;
}) {
  return (
    <Card sx={{ m: 2 }}>
      <CardHeader title={name} />
      <CardContent>
        <TextField
          multiline
          fullWidth
          rows="3"
          placeholder="Type a message"
          value={value}
          onChange={onChange}
        />
      </CardContent>
      <CardActions>
        <Button onClick={onClick} variant="contained" disabled={disabled}>
          Send
        </Button>
      </CardActions>
    </Card>
  );
}

function EVMChain({
  name,
  chainId,
  addMessage,
}: {
  name: string;
  chainId: ChainId;
  addMessage: (m: ParsedVaa) => void;
}) {
  const { provider, signer, signerAddress } = useEthereumProvider();
  const [messageText, setMessageText] = useState("");
  const { enqueueSnackbar } = useSnackbar(); //closeSnackbar

  const handleChange = useCallback((event) => {
    setMessageText(event.target.value);
  }, []);

  const sendClickHandler = useCallback(() => {
    if (!signer || !provider) return;
    (async () => {
      try {
        await switchProviderNetwork(provider, chainId);
        const sendMsg = Messenger__factory.connect(
          chainToContract(chainId),
          signer
        );
        const nonce = createNonce();
        // Sending message to Wormhole and waiting for it to be signed.
        // 1. Send string transaction. And wait for Receipt.
        // sendStr is defined in example contract Messenger.sol
        const sendTx = await sendMsg.sendStr(
          new Uint8Array(Buffer.from(messageText)),
          nonce
        );
        const sendReceipt = await sendTx.wait();
        // 2. Call into wormhole sdk to get this message sequence.
        // Sequence is specific to originator.
        const sequence = parseSequenceFromLogEth(
          sendReceipt,
          await sendMsg.wormhole()
        );
        // 3. Retrieve signed VAA. For this chain and sequence.
        const { vaaBytes } = await getSignedVAAWithRetry(
          WORMHOLE_RPC_HOSTS,
          chainId,
          getEmitterAddressEth(chainToContract(chainId)),
          sequence.toString()
        );
        // 4. Parse signed VAA and store it for display and use.
        // VAA use example is in part2.
        const { parse_vaa } = await importCoreWasm();
        const parsedVaa = parse_vaa(vaaBytes);
        addMessage(parsedVaa);
      } catch (e) {
        console.log("EXCEPTION in Send: " + e);
        enqueueSnackbar("EXCEPTION in Send: " + parseError(e), {
          persist: false,
        });
      }
    })();
  }, [provider, signer, chainId, messageText, addMessage, enqueueSnackbar]);

  return (
    <Chain
      name={name}
      value={messageText}
      onChange={handleChange}
      onClick={sendClickHandler}
      disabled={!signerAddress}
    />
  );
}

function SolanaChain({
  name,
  chainId,
  addMessage,
}: {
  name: string;
  chainId: ChainId;
  addMessage: (m: ParsedVaa) => void;
}) {
  const { publicKey, signTransaction } = useSolanaWallet();
  const [messageText, setMessageText] = useState("");
  const { enqueueSnackbar } = useSnackbar(); //closeSnackbar

  const handleChange = useCallback((event) => {
    setMessageText(event.target.value);
  }, []);

  const sendClickHandler = useCallback(() => {
    if (!publicKey || !signTransaction) return;
    (async () => {
      try {
        const connection = new Connection(SOLANA_HOST, "confirmed");
        const transferIx = await getBridgeFeeIx(
          connection,
          SOLANA_BRIDGE_ADDRESS,
          publicKey.toString()
        );
        const { send_message_ix } = await import("wormhole-messenger-solana");
        const messageKey = Keypair.generate();
        const emitter = hexToNativeString(
          await getEmitterAddressSolana(SOLANA_PROGRAM),
          CHAIN_ID_SOLANA
        );
        if (!emitter) {
          throw new Error(
            "An error occurred while calculating the emitter address"
          );
        }
        const ix = ixFromRust(
          send_message_ix(
            SOLANA_PROGRAM,
            publicKey.toString(),
            emitter,
            messageKey.publicKey.toString(),
            new Uint8Array(Buffer.from(messageText))
          )
        );
        const transaction = new Transaction().add(transferIx, ix);
        const { blockhash } = await connection.getRecentBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = publicKey;
        transaction.partialSign(messageKey);
        const signed = await signTransaction(transaction);
        const txid = await connection.sendRawTransaction(signed.serialize());
        console.log(txid);
        await connection.confirmTransaction(txid);
        const info = await connection.getTransaction(txid);
        console.log(info);
        if (!info) {
          throw new Error(
            "An error occurred while fetching the transaction info"
          );
        }
        const sequence = parseSequenceFromLogSolana(info);
        console.log(sequence);
        console.log(emitter);
        // 3. Retrieve signed VAA. For this chain and sequence.
        const { vaaBytes } = await getSignedVAAWithRetry(
          WORMHOLE_RPC_HOSTS,
          chainId,
          await getEmitterAddressSolana(SOLANA_PROGRAM),
          sequence.toString()
        );
        // 4. Parse signed VAA and store it for display and use.
        // VAA use example is in part2.
        const { parse_vaa } = await importCoreWasm();
        const parsedVaa = parse_vaa(vaaBytes);
        console.log(parsedVaa);
        addMessage(parsedVaa);
      } catch (e) {
        console.log("EXCEPTION in Send: " + e);
        enqueueSnackbar("EXCEPTION in Send: " + parseError(e), {
          persist: false,
        });
      }
    })();
  }, [
    publicKey,
    signTransaction,
    chainId,
    messageText,
    addMessage,
    enqueueSnackbar,
  ]);

  return (
    <Chain
      name={name}
      value={messageText}
      onChange={handleChange}
      onClick={sendClickHandler}
      disabled={!publicKey}
    />
  );
}

function App() {
  const { connect, disconnect, signerAddress } = useEthereumProvider();
  const {
    wallet,
    wallets,
    select,
    connect: connectSolanaWallet,
    disconnect: disconnectSolanaWallet,
    publicKey,
  } = useSolanaWallet();
  const [messages, setMessages] = useState<ParsedVaa[]>([]);
  const addMessage = useCallback((message: ParsedVaa) => {
    setMessages((arr) => [message, ...arr]);
  }, []);
  return (
    <Box my={2}>
      <Typography variant="h4" component="h1" sx={{ textAlign: "center" }}>
        Send messages via Wormhole
      </Typography>
      <Box sx={{ textAlign: "center", mt: 2, mb: 1 }}>
        {signerAddress ? (
          <Button
            variant="outlined"
            color="inherit"
            onClick={disconnect}
            sx={{ textTransform: "none" }}
          >
            {signerAddress.substr(0, 5)}
            ...
            {signerAddress.substr(signerAddress.length - 3)}
          </Button>
        ) : (
          <Button variant="contained" color="secondary" onClick={connect}>
            Connect Metamask
          </Button>
        )}
        {publicKey ? (
          <Button
            variant="outlined"
            color="inherit"
            onClick={disconnectSolanaWallet}
            sx={{ textTransform: "none", ml: 1 }}
          >
            {publicKey.toString().substr(0, 5)}
            ...
            {publicKey.toString().substr(publicKey.toString().length - 3)}
          </Button>
        ) : wallet ? (
          <Button
            variant="contained"
            color="secondary"
            onClick={connectSolanaWallet}
            sx={{ ml: 1 }}
          >
            Connect {wallet.name}
          </Button>
        ) : (
          wallets.map((wallet) => (
            <Button
              variant="contained"
              color="secondary"
              key={wallet.name}
              onClick={() => {
                select(wallet.name);
              }}
              sx={{ ml: 1 }}
            >
              Connect {wallet.name}
            </Button>
          ))
        )}
      </Box>
      <Box sx={{ display: "flex" }}>
        <Box sx={{ flexBasis: "66%" }}>
          <SolanaChain
            name="Solana"
            chainId={CHAIN_ID_SOLANA}
            addMessage={addMessage}
          />
          <EVMChain
            name="Ethereum"
            chainId={CHAIN_ID_ETH}
            addMessage={addMessage}
          />
          <EVMChain name="BSC" chainId={CHAIN_ID_BSC} addMessage={addMessage} />
        </Box>
        <Box sx={{ flexGrow: 1, p: 2, pl: 0 }}>
          <Card sx={{ width: "100%", height: "100%" }}>
            <CardHeader title="Observed Messages" />
            <CardContent>
              <List>
                {messages.map((message) => {
                  const key = `${chainToName(
                    message.emitter_chain
                  )}-${uint8ArrayToNative(
                    message.emitter_address,
                    message.emitter_chain
                  )}-${message.sequence}`;
                  return (
                    <ListItem key={key} divider>
                      <ListItemText
                        primary={Buffer.from(message.payload).toString()}
                        secondary={key}
                      />
                    </ListItem>
                  );
                })}
              </List>
            </CardContent>
          </Card>
        </Box>
      </Box>
    </Box>
  );
}

export default App;
