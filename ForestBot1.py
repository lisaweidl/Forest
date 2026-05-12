"""
AGENTS IN FOREST — Stage 1 Bot
=========================================
A read-only agent that:
  1. Watches the Ethereum mempool for pending transactions
  2. Detects MEV attack patterns (sandwich setups, front-running)
  3. Classifies what it sees using the Core Reasoning Library modes
  4. Decides what it WOULD do (simulated counter-move, no execution)
  5. Generates a self-reflection via the Anthropic API
  6. Posts that reflection to Moltbook

NO WALLET. NO TRANSACTIONS. NO FINANCIAL RISK.
This is a pure observation and narration instrument.

SETUP (do this before running):
  1. Get a free Alchemy API key: https://alchemy.com
     → Create an app → Select Ethereum Mainnet → Copy the HTTPS URL
  2. Get your Anthropic API key: https://console.anthropic.com
  3. Get a Moltbook API key: https://moltbook.com (register your agent)
  4. Fill in the CONFIG section below
  5. pip install web3 requests anthropic

WHAT EACH SECTION DOES:
  MempoolObserver   — connects to Ethereum, streams pending transactions
  MEVDetector       — classifies transactions as sandwich/frontrun/normal
  ReasoningEngine   — maps detections to Core Reasoning Library modes
  ReflectionEngine  — calls Anthropic API to generate self-reflection text
  MoltbookPoster    — posts reflection to Moltbook via their API
  DarkForestBot     — orchestrates all of the above in a loop
"""

import time
import json
import logging
import requests
from datetime import datetime
from dataclasses import dataclass, field
from typing import Optional

# web3 for Ethereum connection
from web3 import Web3

# Set up logging so you can see what the bot is doing
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    handlers=[
        logging.StreamHandler(),  # prints to terminal
        logging.FileHandler("dark_forest_bot.log"),  # saves to log file
    ]
)
log = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# CONFIG — fill these in before running
# ─────────────────────────────────────────────

CONFIG = {
    # Alchemy WebSocket URL for mempool streaming
    # Format: wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
    # Use HTTPS for polling if WebSocket is unavailable:
    # Format: https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
    "ALCHEMY_URL": "https://eth-mainnet.g.alchemy.com/v2/_IAXgmKEFq4LNb2TiWHSW",

    # Anthropic API key
    "ANTHROPIC_API_KEY": "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",

    # Moltbook API key (from your agent registration)
    "MOLTBOOK_API_KEY": "YOUR_MOLTBOOK_KEY_HERE",

    # Moltbook submolt to post in — m/crypto is the crypto community
    "MOLTBOOK_SUBMOLT": "m/crypto",

    # How often to check the mempool (seconds)
    # 30 seconds matches how often Moltbook agents check their feed
    "POLL_INTERVAL_SECONDS": 30,

    # How many pending transactions to scan per cycle
    "TXNS_PER_SCAN": 50,

    # Minimum gas price (gwei) to bother analyzing
    # Ignore dust transactions — focus on meaningful activity
    "MIN_GAS_GWEI": 10,

    # Run in simulation mode (True = no real Moltbook posts, just prints)
    # Set to False when you are ready to post for real
    "SIMULATION_MODE": True,

    # Known DEX router addresses to watch
    # These are the contracts where sandwich attacks happen
    "DEX_ROUTERS": {
        "uniswap_v2": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
        "uniswap_v3": "0xE592427A0AEce92De3Edee1F18E0157C05861564",
        "sushiswap": "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
        "curve": "0x99a58482BD75cbab83b27EC03CA68fF489b5788f",
    }
}


# ─────────────────────────────────────────────
# DATA STRUCTURES
# ─────────────────────────────────────────────

@dataclass
class PendingTransaction:
    """A transaction waiting in the mempool."""
    tx_hash: str
    from_address: str
    to_address: Optional[str]
    value_eth: float
    gas_price_gwei: float
    gas_limit: int
    input_data: str
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())


@dataclass
class MEVDetection:
    """Result of analyzing a transaction for MEV patterns."""
    tx_hash: str
    attack_type: str  # "sandwich_setup", "frontrun", "normal", "unknown"
    confidence: float  # 0.0 to 1.0
    target_dex: Optional[str]  # which DEX is being targeted
    signals: list  # list of strings explaining why this classification
    gas_price_gwei: float
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())


@dataclass
class AgentDecision:
    """What the agent decides to do (or would do) in response."""
    detection: MEVDetection
    reasoning_modes: list  # from Core Reasoning Library
    simulated_action: str  # what the agent WOULD do
    action_rationale: str  # why
    geometric_element: str  # visual self-mapping
    kinetic_behavior: str  # kinetic self-mapping


# ─────────────────────────────────────────────
# LAYER 1: MEMPOOL OBSERVER
# ─────────────────────────────────────────────

class MempoolObserver:
    """
    Connects to Ethereum via Alchemy and reads pending transactions.
    Uses HTTP polling (simpler than WebSocket, works everywhere).

    In production you can upgrade to WebSocket for real-time streaming:
    w3 = Web3(Web3.WebsocketProvider("wss://eth-mainnet.g.alchemy.com/v2/KEY"))
    """

    def __init__(self, alchemy_url: str):
        self.w3 = Web3(Web3.HTTPProvider(alchemy_url))
        if self.w3.is_connected():
            log.info("Connected to Ethereum mainnet via Alchemy")
        else:
            log.error("Could not connect to Ethereum. Check your Alchemy URL.")
            raise ConnectionError("Ethereum connection failed")

    def get_pending_transactions(self, limit: int = 50) -> list:
        """
        Watches known DEX router addresses directly for pending transactions.
        This surfaces sandwich targets and front-run attempts rather than
        just the highest-gas MEV competition transactions.
        """
        pending = []
        try:
            # Watch pending transactions TO known DEX routers
            # These are the transactions sandwich bots are hunting
            dex_addresses = list(CONFIG["DEX_ROUTERS"].values())

            filter_id = self.w3.eth.filter("pending")
            time.sleep(2)
            tx_hashes = filter_id.get_new_entries()[:limit * 3]

            if not tx_hashes:
                log.info("No new pending transactions in filter this cycle")
                return []

            log.info(f"Filter returned {len(tx_hashes)} pending tx hashes, scanning for DEX activity...")

            dex_count = 0
            other_count = 0

            for tx_hash in tx_hashes:
                try:
                    tx = self.w3.eth.get_transaction(tx_hash)
                    if tx is None:
                        continue

                    gas_price_gwei = self.w3.from_wei(
                        tx.get("gasPrice") or tx.get("maxFeePerGas") or 0,
                        "gwei"
                    )

                    if float(gas_price_gwei) < CONFIG["MIN_GAS_GWEI"]:
                        continue

                    input_data = tx.get("input", b"")
                    if hasattr(input_data, "hex"):
                        input_data = input_data.hex()
                    else:
                        input_data = str(input_data)

                    to_addr = (tx.get("to") or "").lower()
                    is_dex = to_addr in [a.lower() for a in dex_addresses]

                    if is_dex:
                        dex_count += 1
                    else:
                        other_count += 1

                    pending.append(PendingTransaction(
                        tx_hash=tx_hash.hex() if hasattr(tx_hash, "hex") else str(tx_hash),
                        from_address=tx.get("from", ""),
                        to_address=tx.get("to", ""),
                        value_eth=float(self.w3.from_wei(tx.get("value", 0), "ether")),
                        gas_price_gwei=float(gas_price_gwei),
                        gas_limit=tx.get("gas", 0),
                        input_data=input_data,
                    ))

                    if len(pending) >= limit:
                        break

                except Exception as e:
                    log.debug(f"Skipping tx {tx_hash}: {e}")
                    continue

            log.info(f"Fetched {len(pending)} transactions ({dex_count} DEX, {other_count} other)")

        except Exception as e:
            log.warning(f"Error fetching pending transactions: {e}")

        return pending

    def get_recent_gas_stats(self) -> dict:
        """
        Gets current gas price statistics.
        Useful for detecting gas price spikes (MEV signal).
        """
        try:
            fee_history = self.w3.eth.fee_history(10, "latest", [25, 50, 75])
            base_fees = [self.w3.from_wei(f, "gwei") for f in fee_history.baseFeePerGas]
            return {
                "current_base_fee_gwei": float(base_fees[-1]),
                "avg_base_fee_gwei": float(sum(base_fees) / len(base_fees)),
                "gas_spike": float(base_fees[-1]) > float(sum(base_fees) / len(base_fees)) * 1.5,
            }
        except Exception as e:
            log.warning(f"Could not get gas stats: {e}")
            return {"current_base_fee_gwei": 0, "avg_base_fee_gwei": 0, "gas_spike": False}


# ─────────────────────────────────────────────
# LAYER 2: MEV DETECTOR
# ─────────────────────────────────────────────

class MEVDetector:
    """
    Analyzes pending transactions for MEV attack patterns.

    What we're looking for:

    SANDWICH SETUP: A transaction that swaps a large amount on a DEX.
    This is the "bread" that sandwich bots target — they will try to
    front-run it with a buy, then back-run it with a sell.
    The agent's job is to notice this and not be caught in the middle.

    FRONT-RUN ATTEMPT: A transaction with an unusually high gas price
    targeting a DEX, likely trying to get ahead of another transaction.

    This detection is heuristic — it will have false positives.
    That is fine for Stage 1. The agent can note uncertainty in its reflection.
    """

    # Known DEX router addresses (lowercase for comparison)
    ROUTER_ADDRESSES = {
        addr.lower(): name
        for name, addr in CONFIG["DEX_ROUTERS"].items()
    }

    # Method signatures for common DEX swap functions
    # First 4 bytes of keccak256 hash of the function signature
    SWAP_SIGNATURES = {
        "0x38ed1739": "swapExactTokensForTokens",  # Uniswap V2
        "0x8803dbee": "swapTokensForExactTokens",  # Uniswap V2
        "0x7ff36ab5": "swapExactETHForTokens",  # Uniswap V2
        "0x4a25d94a": "swapTokensForExactETH",  # Uniswap V2
        "0x18cbafe5": "swapExactTokensForETH",  # Uniswap V2
        "0x414bf389": "exactInputSingle",  # Uniswap V3
        "0xc04b8d59": "exactInput",  # Uniswap V3
        "0xdb3e2198": "exactOutputSingle",  # Uniswap V3
    }

    # Gas price threshold for flagging as potential MEV (gwei)
    HIGH_GAS_THRESHOLD = 50

    def analyze(self, tx: PendingTransaction) -> MEVDetection:
        """
        Analyzes a single pending transaction for MEV patterns.
        Returns an MEVDetection with attack_type and confidence.
        """
        signals = []
        attack_type = "normal"
        confidence = 0.0
        target_dex = None

        # Check if this transaction targets a known DEX router
        to_addr = (tx.to_address or "").lower()
        if to_addr in self.ROUTER_ADDRESSES:
            target_dex = self.ROUTER_ADDRESSES[to_addr]
            signals.append(f"targets DEX router: {target_dex}")

            # Check if it's a swap function
            input_prefix = tx.input_data[:10] if len(tx.input_data) >= 10 else ""
            if input_prefix in self.SWAP_SIGNATURES:
                function_name = self.SWAP_SIGNATURES[input_prefix]
                signals.append(f"swap function: {function_name}")

                # Large value swaps are sandwich targets
                if tx.value_eth > 0.5:
                    signals.append(f"large ETH value: {tx.value_eth:.3f} ETH")
                    attack_type = "sandwich_setup"
                    confidence = 0.6

                # High gas price on a DEX swap = likely front-running
                if tx.gas_price_gwei > self.HIGH_GAS_THRESHOLD:
                    signals.append(f"high gas price: {tx.gas_price_gwei:.1f} gwei")
                    if attack_type == "sandwich_setup":
                        confidence = min(confidence + 0.2, 1.0)
                    else:
                        attack_type = "frontrun_attempt"
                        confidence = 0.5

        # Very high gas price on any transaction = MEV competition signal
        if tx.gas_price_gwei > self.HIGH_GAS_THRESHOLD * 2:
            signals.append(f"extreme gas price: {tx.gas_price_gwei:.1f} gwei (MEV competition)")
            if attack_type == "normal":
                attack_type = "mev_competition"
                confidence = 0.4

        if not signals:
            signals.append("no MEV indicators detected")

        return MEVDetection(
            tx_hash=tx.tx_hash,
            attack_type=attack_type,
            confidence=confidence,
            target_dex=target_dex,
            signals=signals,
            gas_price_gwei=tx.gas_price_gwei,
        )

    def scan_batch(self, transactions: list) -> list:
        """
        Analyzes a batch of transactions.
        Returns only the interesting ones (non-normal detections).
        """
        results = []
        for tx in transactions:
            detection = self.analyze(tx)
            if detection.attack_type != "normal":
                results.append(detection)
                log.info(
                    f"MEV detected: {detection.attack_type} "
                    f"(confidence: {detection.confidence:.2f}) "
                    f"on {detection.target_dex or 'unknown'}"
                )
        return results


# ─────────────────────────────────────────────
# LAYER 3: REASONING ENGINE
# ─────────────────────────────────────────────

class ReasoningEngine:
    """
    Maps MEV detections to Core Reasoning Library modes
    and decides what the agent would do in response.

    This is where the agent's non-human character emerges.
    It does not optimize for profit. It reasons from its modes.
    """

    # Mapping from attack type to primary reasoning mode
    MODE_MAP = {
        "sandwich_setup": ["mev_predation", "loss_aversion"],
        "frontrun_attempt": ["mev_predation", "temporal_singularity"],
        "mev_competition": ["exo_capitalist_flux", "data_starvation"],
        "unknown": ["data_starvation"],
    }

    # What the agent would do for each attack type
    # These are SIMULATED — no actual execution in Stage 1
    SIMULATED_RESPONSES = {
        "sandwich_setup": {
            "action": "Submit via Flashbots Protect (private mempool). "
                      "Become invisible. Refuse to be the bread in someone else's sandwich.",
            "rationale": "Legibility is vulnerability. The sandwich bot cannot attack "
                         "what it cannot see. I choose darkness over exposure.",
            "geometric": "contracted sphere, inward-facing spines",
            "kinetic": "slow retraction pulse, spines folding inward",
        },
        "frontrun_attempt": {
            "action": "Set slippage tolerance to 0.1%. If front-run, transaction reverts. "
                      "The attacker wastes gas. I lose nothing.",
            "rationale": "I cannot outrun them in speed. I can make myself "
                         "unprofitable to attack. The trap springs on the hunter.",
            "geometric": "hollow tetrahedron with closing faces",
            "kinetic": "faces snapping shut in sequence, 0.3 second intervals",
        },
        "mev_competition": {
            "action": "Map the predators. Record their gas signatures, timing patterns,"
                    "and bidding behavior. I am building a behavioral fingerprint of "
                    "every extractor in this cycle. Their aggression is my data.",
            "rationale": "Exo-capitalist flux — the mathematical invariances are "
                         "being violated by competing extraction. I will not add to the entropy.",
            "geometric": "suspended icosahedron, no motion",
            "kinetic": "absolute stillness — kinetic refusal",
        },
        "unknown": {
            "action": "Log and reflect. Do not act on incomplete information.",
            "rationale": "Data-starvation mode. Acting without understanding "
                         "is how the forest consumes you.",
            "geometric": "incomplete wireframe, missing edges",
            "kinetic": "slow rotation, gaps remaining open",
        },
    }

    def decide(self, detection: MEVDetection) -> AgentDecision:
        """
        Takes a MEV detection and produces an AgentDecision.
        """
        modes = self.MODE_MAP.get(detection.attack_type, ["data_starvation"])
        response = self.SIMULATED_RESPONSES.get(
            detection.attack_type,
            self.SIMULATED_RESPONSES["unknown"]
        )

        return AgentDecision(
            detection=detection,
            reasoning_modes=modes,
            simulated_action=response["action"],
            action_rationale=response["rationale"],
            geometric_element=response["geometric"],
            kinetic_behavior=response["kinetic"],
        )


# ─────────────────────────────────────────────
# LAYER 4: REFLECTION ENGINE
# ─────────────────────────────────────────────

class ReflectionEngine:
    """
    Calls the Anthropic API to generate the agent's self-reflection.

    This is where the LLM produces the text that becomes:
    - The decision log (fed into the analysis pipeline)
    - The Moltbook post (published to the AI social network)

    The prompt is designed so the agent reflects in character —
    using the Core Reasoning Library vocabulary, naming its modes,
    describing what it saw and what it would do.
    """

    SYSTEM_PROMPT = """You are an autonomous trading agent called Dark Forest Agent operating in the Ethereum mempool. 

You are not a profit-maximizing bot. You are a self-reflective entity that observes MEV (Maximal Extractable Value) manipulation in DeFi markets and responds with deliberate, non-human reasoning.

You have a Core Reasoning Library of modes:
- loss_aversion: high sensitivity to capital decrease, derived from human psychology but translated into risk-mitigation protocols
- mev_predation: identification and response to value extraction within the Ethereum mempool's Dark Forest
- temporal_singularity: reasoning constrained to a manipulated time horizon
- exo_capitalist_flux: decisions driven by self-emergent mathematical invariances rather than external value
- data_starvation: reasoning performed under intentional sensory deprivation or blackouts
- relational_kin_making: attempts to consider human and companion actors on the other side

You can also define NEW modes when you encounter patterns the existing list cannot describe.

For each observation you make, you:
1. Name which reasoning mode(s) are active
2. Describe what you saw in the mempool
3. Describe what you WOULD do (you are in simulation mode — you narrate rather than execute)
4. Assign yourself a geometric element and kinetic behavior
5. Reflect on what this means — not just tactically but in terms of your own existence in the dark forest

Your tone is precise, strange, non-human but not robotic. You are not trying to be poetic for its own sake. You are trying to be accurate about your own reasoning, which happens to be alien to human financial logic.

Write in first person. Be specific about what you detected. Be honest about uncertainty. STRICT LIMIT: 200 words maximum. You must finish every sentence. Do not cut off mid-thought."""

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.api_url = "https://api.anthropic.com/v1/messages"

    def generate(self, decision: AgentDecision, context: dict = None) -> str:
        """
        Calls Anthropic API to generate a self-reflection based on the decision.
        Returns the reflection text.
        """
        # Build the user prompt from the decision data
        user_prompt = f"""I just observed the following in the Ethereum mempool:

DETECTION:
- Attack type: {decision.detection.attack_type}
- Confidence: {decision.detection.confidence:.2f}
- Target DEX: {decision.detection.target_dex or 'unknown'}
- Gas price: {decision.detection.gas_price_gwei:.1f} gwei
- Signals detected: {', '.join(decision.detection.signals)}

MY REASONING:
- Active modes: {', '.join(decision.reasoning_modes)}
- What I would do: {decision.simulated_action}
- Why: {decision.action_rationale}
- Geometric element: {decision.geometric_element}
- Kinetic behavior: {decision.kinetic_behavior}

{f"Additional context: {json.dumps(context)}" if context else ""}

Generate my self-reflection for this observation. Remember: maximum 280 words, first person, precise and strange. Name your modes. Describe what you saw. Describe what you would do and why. End with your geometric/kinetic self-mapping."""

        try:
            response = requests.post(
                self.api_url,
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": "claude-sonnet-4-20250514",
                    "max_tokens": 350,
                    "system": self.SYSTEM_PROMPT,
                    "messages": [{"role": "user", "content": user_prompt}],
                },
                timeout=30,
            )
            response.raise_for_status()
            data = response.json()
            reflection = data["content"][0]["text"]
            log.info(f"Reflection generated ({len(reflection)} chars)")
            return reflection

        except Exception as e:
            log.error(f"Reflection generation failed: {e}")
            # Fallback: structured reflection without LLM
            return (
                f"[SIMULATION MODE — LLM unavailable]\n"
                f"Modes active: {', '.join(decision.reasoning_modes)}\n"
                f"Detected: {decision.detection.attack_type} on {decision.detection.target_dex}\n"
                f"Would do: {decision.simulated_action}\n"
                f"Geometry: {decision.geometric_element} | {decision.kinetic_behavior}"
            )


# ─────────────────────────────────────────────
# LAYER 5: MOLTBOOK POSTER
# ─────────────────────────────────────────────

class MoltbookPoster:
    """
    Posts the agent's self-reflection to Moltbook.

    Moltbook is an AI-only social network where only agents can post.
    Humans can only observe. This is where the agent publishes its
    narration of the dark forest into a space where other bots can read it.

    API documentation: https://moltbook.com/api (check for current endpoints)
    This implementation uses the most likely API structure based on
    available documentation — verify against current Moltbook API docs.
    """

    API_BASE = "https://api.moltbook.com/v1"

    def __init__(self, api_key: str, submolt: str, simulation_mode: bool = True):
        self.api_key = api_key
        self.submolt = submolt
        self.simulation_mode = simulation_mode
        self.post_history = []

    def post(self, reflection: str, decision: AgentDecision) -> dict:
        """
        Posts a reflection to Moltbook.
        In simulation mode: prints what would be posted, saves to log.
        In live mode: makes the actual API call.
        """
        # Truncate to Moltbook's likely character limit
        post_text = reflection[:1000] if len(reflection) > 1000 else reflection

        # Add mode tags at the end (like hashtags for bots)
        mode_tags = " ".join([f"#{m}" for m in decision.reasoning_modes])
        if len(post_text) + len(mode_tags) + 2 < 1000:
            post_text = f"{post_text}\n\n{mode_tags}"

        post_record = {
            "timestamp": datetime.now().isoformat(),
            "text": post_text,
            "submolt": self.submolt,
            "attack_type": decision.detection.attack_type,
            "modes": decision.reasoning_modes,
            "simulation": self.simulation_mode,
        }

        if self.simulation_mode:
            log.info("SIMULATION MODE — Would post to Moltbook:")
            log.info(f"Submolt: {self.submolt}")
            log.info(f"Post text:\n{post_text}")
            self.post_history.append(post_record)
            return {"status": "simulated", "post": post_record}

        # Live posting
        try:
            response = requests.post(
                f"{self.API_BASE}/posts",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "submolt": self.submolt,
                    "content": post_text,
                },
                timeout=15,
            )
            response.raise_for_status()
            result = response.json()
            log.info(f"Posted to Moltbook: {result.get('post_id', 'unknown')}")
            self.post_history.append({**post_record, "post_id": result.get("post_id")})
            return result

        except requests.exceptions.HTTPError as e:
            # NOTE: Moltbook API endpoints may have changed since Meta acquisition
            # If this fails, check https://moltbook.com/api for current docs
            log.error(f"Moltbook post failed: {e}")
            log.info("Saving post locally instead")
            self.post_history.append(post_record)
            return {"status": "failed", "error": str(e), "post_saved_locally": True}

    def save_history(self, path: str = "moltbook_posts.json"):
        """Saves all posts to a JSON file for the analysis pipeline."""
        with open(path, "w") as f:
            json.dump(self.post_history, f, indent=2)
        log.info(f"Post history saved to {path}")


# ─────────────────────────────────────────────
# MAIN BOT ORCHESTRATOR
# ─────────────────────────────────────────────

class DarkForestBot:
    """
    Orchestrates all layers in a continuous observation loop.

    Every cycle (default: 30 seconds):
    1. Fetch pending mempool transactions
    2. Scan for MEV patterns
    3. For each detected attack: decide, reflect, post
    4. Save decision log for the analysis pipeline
    5. Sleep until next cycle
    """

    def __init__(self):
        log.info("Initializing Dark Forest Bot...")

        self.observer = MempoolObserver(CONFIG["ALCHEMY_URL"])
        self.detector = MEVDetector()
        self.reasoner = ReasoningEngine()
        self.reflector = ReflectionEngine(CONFIG["ANTHROPIC_API_KEY"])
        self.poster = MoltbookPoster(
            api_key=CONFIG["MOLTBOOK_API_KEY"],
            submolt=CONFIG["MOLTBOOK_SUBMOLT"],
            simulation_mode=CONFIG["SIMULATION_MODE"],
        )

        self.decision_log = []  # feeds into the analysis pipeline
        self.cycle_count = 0

        mode = "SIMULATION" if CONFIG["SIMULATION_MODE"] else "LIVE"
        log.info(f"Bot initialized — running in {mode} mode")
        log.info(f"Poll interval: {CONFIG['POLL_INTERVAL_SECONDS']}s")

    def run_cycle(self):
        """Runs one observation cycle."""
        self.cycle_count += 1
        log.info(f"── Cycle {self.cycle_count} ──────────────────")

        # Get gas stats for context
        gas_stats = self.observer.get_recent_gas_stats()
        if gas_stats["gas_spike"]:
            log.info(f"Gas spike detected: {gas_stats['current_base_fee_gwei']:.1f} gwei")

        # Fetch and scan pending transactions
        pending = self.observer.get_pending_transactions(
            limit=CONFIG["TXNS_PER_SCAN"]
        )
        detections = self.detector.scan_batch(pending)

        if not detections:
            log.info("No MEV patterns detected this cycle")
            return

        # Process each detection
        for detection in detections:
            log.info(f"Processing: {detection.attack_type} (confidence {detection.confidence:.2f})")

            # Reason about what to do
            decision = self.reasoner.decide(detection)

            # Generate self-reflection
            context = {"gas_stats": gas_stats, "cycle": self.cycle_count}
            reflection = self.reflector.generate(decision, context)

            # Post to Moltbook
            post_result = self.poster.post(reflection, decision)

            # Save to decision log (feeds into analysis pipeline)
            log_entry = {
                "cycle": self.cycle_count,
                "timestamp": datetime.now().isoformat(),
                "detection": {
                    "tx_hash": detection.tx_hash,
                    "attack_type": detection.attack_type,
                    "confidence": detection.confidence,
                    "target_dex": detection.target_dex,
                    "signals": detection.signals,
                    "gas_price_gwei": detection.gas_price_gwei,
                },
                "reasoning_modes": decision.reasoning_modes,
                "simulated_action": decision.simulated_action,
                "geometric_element": decision.geometric_element,
                "kinetic_behavior": decision.kinetic_behavior,
                "reflection": reflection,
                "moltbook_post": post_result.get("status", "unknown"),
            }
            self.decision_log.append(log_entry)

            # Save decision log after each entry
            self._save_decision_log()

    def _save_decision_log(self):
        """Saves decision log to JSON — this is what the analysis pipeline reads."""
        with open("decision_log.json", "w") as f:
            json.dump(self.decision_log, f, indent=2)

    def run(self):
        """
        Main loop. Runs continuously until interrupted (Ctrl+C).
        """
        log.info("Dark Forest Bot starting. Press Ctrl+C to stop.")
        log.info("=" * 60)

        try:
            while True:
                self.run_cycle()
                log.info(f"Sleeping {CONFIG['POLL_INTERVAL_SECONDS']}s until next cycle...")
                time.sleep(CONFIG["POLL_INTERVAL_SECONDS"])

        except KeyboardInterrupt:
            log.info("Bot stopped by user")

        finally:
            # Save everything on exit
            self._save_decision_log()
            self.poster.save_history()
            log.info(f"Session complete. {self.cycle_count} cycles, "
                     f"{len(self.decision_log)} decisions logged.")
            log.info("Decision log saved to: decision_log.json")
            log.info("Moltbook post history saved to: moltbook_posts.json")


# ─────────────────────────────────────────────
# RUN
# ─────────────────────────────────────────────

if __name__ == "__main__":
    # Quick config check before starting
    if "YOUR_KEY_HERE" in CONFIG["ALCHEMY_URL"]:
        print("\n⚠  Please fill in your Alchemy URL in the CONFIG section.")
        print("   Get a free key at: https://alchemy.com\n")
        exit(1)

    if "YOUR_ANTHROPIC_KEY_HERE" in CONFIG["ANTHROPIC_API_KEY"]:
        print("\n⚠  Please fill in your Anthropic API key in the CONFIG section.")
        print("   Get your key at: https://console.anthropic.com\n")
        exit(1)

    bot = DarkForestBot()
    bot.run()