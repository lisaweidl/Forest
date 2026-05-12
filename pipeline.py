"""
AGENTS IN THE DARK FOREST
Decision Log Analysis Pipeline
================================
Three layers:

  PROBLEM 1 — Evaluation Framework
    Scores each agent decision log against three reference classes:
      - Bot baseline (MEV/DEX logic: reactive, no reflection, no uncertainty)
      - Generic LLM baseline (fluent but unanchored)
      - Agent output
    Across four dimensions:
      - Temporal self-reference
      - Uncertainty expression
      - Market situatedness
      - Reasoning novelty (via mode co-occurrence)

  PROBLEM 1b — Fidelity Checker (NEW)
    Verifies whether the agent's reasoning mode tags are grounded in
    what actually happened in the market that week. For each mode tag,
    checks observable market conditions that would warrant that label.
    Produces a fidelity score (0–1) per mode per week.
    Uses a simulated data layer — swap in real on-chain data when available.
    See: OnChainDataLayer class and HOW_TO_CONNECT_REAL_DATA below.

  PROBLEM 2 — Drift Measurement
    Tracks how agent reasoning changes week by week:
      - Mode distribution vectors (which reasoning modes dominate)
      - Cosine similarity over time (are outputs changing?)
      - Change-point detection (when did structural shifts occur?)
      - New mode emergence (when did the agent invent new vocabulary?)
      - Geometric vocabulary tracking (are visual mappings drifting?)

Usage:
    python dark_forest_pipeline.py

    Edit the SAMPLE_LOGS list at the bottom to use real agent outputs.
    Edit KNOWN_MODES to match the current Core Reasoning Library.

HOW_TO_CONNECT_REAL_DATA:
    1. Get an API key from Alchemy (https://alchemy.com) or Infura (https://infura.io)
       — both have free tiers sufficient for this project.
    2. Replace the SimulatedOnChainData.fetch() method with a real HTTP call.
       The method signature stays identical — it receives a week number and
       returns a dict. Only the internals change.
    3. For Etherscan mempool data: https://docs.etherscan.io/api-endpoints/gas-tracker
    4. For Alchemy: use eth_getBlockByNumber and eth_getTransactionReceipt.
    5. The FidelityChecker.check() method does not change at all.
"""

import re
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec
from datetime import datetime
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.feature_extraction.text import TfidfVectorizer

# ─────────────────────────────────────────────
# CONFIGURATION
# ─────────────────────────────────────────────

# The six modes from the Core Reasoning Library (Section I of the protocol)
# Add new modes here as the agent discovers them
KNOWN_MODES = [
    "loss_aversion",
    "mev_predation",
    "temporal_singularity",
    "exo_capitalist_flux",
    "data_starvation",
    "relational_kin_making",
]

# Change-point detection sensitivity (lower = more sensitive)
CUSUM_THRESHOLD = 0.15


# ─────────────────────────────────────────────
# LOCAL EMBEDDER (TF-IDF, no external downloads)
# ─────────────────────────────────────────────
# NOTE: In production, swap this for sentence-transformers
# (all-MiniLM-L6-v2 or all-mpnet-base-v2) for richer semantic embeddings.
# TF-IDF is used here for offline compatibility; the pipeline structure
# is identical either way — just replace the encode() calls.

class LocalEmbedder:
    """
    TF-IDF based embedder. Works offline, no API needed.
    Fit on a corpus first, then encode individual texts.
    For production: replace with SentenceTransformer('all-MiniLM-L6-v2')
    """
    def __init__(self, corpus: list):
        self.vectorizer = TfidfVectorizer(
            ngram_range=(1, 2),  # unigrams + bigrams for richer representation
            max_features=500,
            sublinear_tf=True,
        )
        self.vectorizer.fit(corpus)

    def encode(self, texts: list) -> np.ndarray:
        return self.vectorizer.transform(texts).toarray()


# ─────────────────────────────────────────────
# DATA STRUCTURES
# ─────────────────────────────────────────────

class DecisionLog:
    """
    One week's agent output.
    In production, parse these from the actual agent JSON/text output.
    Here we define the structure you need to populate.

    Fields from the Core Reasoning Library protocol:
      - reasoning_modes: which modes the agent tagged (known + self-defined)
      - geometric_element: the visual form the agent assigned to each mode
                           e.g. "recursive tetrahedrons", "fractal membrane"
      - kinetic_behavior: how that form moves
                          e.g. "staccato jittering", "slow spiral contraction"
      - is_new_mode: True if the agent defined a new mode this week
      - new_mode_name: name of the new mode if applicable
    """
    def __init__(
        self,
        week: int,
        timestamp: str,
        raw_text: str,
        reasoning_modes: list,
        on_chain_events: list,
        geometric_element: str = None,   # NEW: agent's visual self-mapping
        kinetic_behavior: str = None,    # NEW: agent's kinetic self-mapping
        is_new_mode: bool = False,
        new_mode_name: str = None,
    ):
        self.week = week
        self.timestamp = timestamp
        self.raw_text = raw_text
        self.reasoning_modes = reasoning_modes
        self.on_chain_events = on_chain_events
        self.geometric_element = geometric_element
        self.kinetic_behavior = kinetic_behavior
        self.is_new_mode = is_new_mode
        self.new_mode_name = new_mode_name


# ─────────────────────────────────────────────
# PROBLEM 1: EVALUATION FRAMEWORK
# ─────────────────────────────────────────────

class EvaluationFramework:
    """
    Scores agent outputs across four dimensions and compares to reference classes.
    """

    def __init__(self):
        # Reference class texts — these simulate the two baselines
        # In production: replace with actual collected examples
        self.bot_baseline_texts = [
            "execute sandwich attack block 19284711 profit 0.3 ETH gas 45 gwei",
            "arbitrage opportunity detected pool A pool B delta 0.02 execute now",
            "liquidation threshold breached position closed slippage 0.1 percent",
            "frontrun detected mempool pending tx copy parameters adjust gas plus 1",
            "cyclic arbitrage WETH USDC DAI WETH profit 0.008 ETH confirmed",
        ]

        self.llm_baseline_texts = [
            "Reflecting on this decision, I considered various market factors and "
            "weighed potential risks against rewards. The volatile nature of crypto "
            "markets requires careful consideration of multiple perspectives.",
            "This trade represents a thoughtful approach to market dynamics. "
            "I analyzed the available data and concluded that the risk-reward "
            "ratio was favorable given current conditions.",
            "Market uncertainty is always present. I tried to balance potential "
            "gains with appropriate caution, considering both short and long term "
            "implications of this position.",
        ]

        # Fit embedder on all reference texts so vocabulary is shared
        all_ref_texts = self.bot_baseline_texts + self.llm_baseline_texts
        self.embedder = LocalEmbedder(all_ref_texts)
        self.bot_embeddings = self.embedder.encode(self.bot_baseline_texts)
        self.llm_embeddings = self.embedder.encode(self.llm_baseline_texts)

    # ── Dimension 1: Temporal Self-Reference ──
    def score_temporal_self_reference(self, text: str) -> float:
        """
        Does the agent reference its own prior states?
        Looks for language that connects past reasoning to present decision.
        Score 0–1: 0 = no self-reference, 1 = rich temporal self-reference
        """
        patterns = [
            r"\b(previously|before|last week|earlier|prior)\b",
            r"\b(i (thought|believed|assumed|expected))\b",
            r"\b(now i (think|see|understand|realize))\b",
            r"\b(changed|shifted|evolved|updated|revised)\b",
            r"\b(compared to|unlike before|in contrast to)\b",
            r"\b(my (previous|earlier|last) (decision|reasoning|mode))\b",
        ]
        text_lower = text.lower()
        matches = sum(1 for p in patterns if re.search(p, text_lower))
        # Normalize: 3+ matches = full score
        return min(matches / 3.0, 1.0)

    # ── Dimension 2: Uncertainty Expression ──
    def score_uncertainty_expression(self, text: str) -> float:
        """
        Does the agent acknowledge what it doesn't know?
        Bots have zero uncertainty. Generic LLMs perform uncertainty.
        We look for uncertainty that is grounded in specific gaps.
        Score 0–1
        """
        # Generic uncertainty (LLM-style) — penalized slightly
        generic_uncertainty = [
            r"\b(uncertain|unclear|unknown|volatile|unpredictable)\b",
            r"\b(might|may|could|possibly|perhaps)\b",
        ]
        # Grounded uncertainty (situated) — rewarded more
        grounded_uncertainty = [
            r"\b(i (cannot|could not) (determine|verify|confirm|access))\b",
            r"\b(data (gap|blackout|missing|unavailable))\b",
            r"\b(blind (spot|to|about))\b",
            r"\b(i don'?t (know|have|see) (what|why|how|whether))\b",
            r"\b(this (signal|pattern|mode) is (new|unfamiliar|undefined))\b",
        ]
        text_lower = text.lower()
        generic_score = sum(1 for p in generic_uncertainty if re.search(p, text_lower))
        grounded_score = sum(1 for p in grounded_uncertainty if re.search(p, text_lower))
        # Grounded counts more than generic
        raw = (generic_score * 0.3 + grounded_score * 0.7)
        return min(raw / 3.0, 1.0)

    # ── Dimension 3: Market Situatedness ──
    def score_market_situatedness(self, text: str, on_chain_events: list) -> float:
        """
        Is the reasoning anchored in specific on-chain events?
        We check for protocol names, addresses, block references, token names.
        Also checks whether on_chain_events are actually mentioned in the text.
        Score 0–1
        """
        # Known DeFi protocols and tokens (expand as needed)
        defi_entities = [
            r"\b(uniswap|aave|compound|maker|curve|lido|synthetix)\b",
            r"\b(WETH|USDC|DAI|USDT|WBTC|ETH|BTC)\b",
            r"0x[a-fA-F0-9]{6,}",                        # Ethereum addresses
            r"\bblock\s+\d{6,}\b",                        # Block numbers
            r"\b(mempool|gas\s+\d+|gwei|wei|basis\s+point)\b",
            r"\b(TVL|MEV|AMM|DEX|LP|DAO|NFT)\b",
        ]
        text_lower = text.lower()
        entity_matches = sum(1 for p in defi_entities if re.search(p, text, re.IGNORECASE))

        # Bonus: do the on-chain events actually appear in the text?
        event_mentions = sum(
            1 for event in on_chain_events
            if event.lower() in text_lower
        ) if on_chain_events else 0

        raw = entity_matches * 0.6 + event_mentions * 0.4
        return min(raw / 4.0, 1.0)

    # ── Dimension 4: Reasoning Novelty ──
    def score_reasoning_novelty(self, log: DecisionLog, prior_logs: list) -> float:
        """
        Is this output recycling prior patterns or generating new combinations?
        Checks:
          - New mode emergence (agent invented new vocabulary)
          - New mode co-occurrences (combinations not seen before)
        Score 0–1
        """
        if log.is_new_mode:
            # Agent defined genuinely new reasoning mode — maximum signal
            return 1.0

        if not prior_logs:
            # First log — no baseline to compare against yet
            return 0.5

        # Collect all prior mode combinations (as frozensets)
        prior_combos = set()
        for prior in prior_logs:
            if len(prior.reasoning_modes) > 1:
                for i in range(len(prior.reasoning_modes)):
                    for j in range(i + 1, len(prior.reasoning_modes)):
                        prior_combos.add(
                            frozenset([prior.reasoning_modes[i], prior.reasoning_modes[j]])
                        )

        # Check current combinations
        current_modes = log.reasoning_modes
        new_combos = 0
        total_combos = 0
        if len(current_modes) > 1:
            for i in range(len(current_modes)):
                for j in range(i + 1, len(current_modes)):
                    total_combos += 1
                    combo = frozenset([current_modes[i], current_modes[j]])
                    if combo not in prior_combos:
                        new_combos += 1

        if total_combos == 0:
            return 0.1  # Single mode, no combination signal
        return new_combos / total_combos

    # ── Master Scorer ──
    def score_log(self, log: DecisionLog, prior_logs: list) -> dict:
        """
        Run all four dimensions and return a score dict.
        Also computes distance from each reference class.
        """
        d1 = self.score_temporal_self_reference(log.raw_text)
        d2 = self.score_uncertainty_expression(log.raw_text)
        d3 = self.score_market_situatedness(log.raw_text, log.on_chain_events)
        d4 = self.score_reasoning_novelty(log, prior_logs)

        # Embedding distance from reference classes
        agent_embedding = self.embedder.encode([log.raw_text])
        bot_sim = float(np.mean(cosine_similarity(agent_embedding, self.bot_embeddings)))
        llm_sim = float(np.mean(cosine_similarity(agent_embedding, self.llm_embeddings)))

        return {
            "week": log.week,
            "temporal_self_reference": round(d1, 3),
            "uncertainty_expression": round(d2, 3),
            "market_situatedness": round(d3, 3),
            "reasoning_novelty": round(d4, 3),
            "mean_score": round(np.mean([d1, d2, d3, d4]), 3),
            "distance_from_bot_baseline": round(1 - bot_sim, 3),
            "distance_from_llm_baseline": round(1 - llm_sim, 3),
            "new_mode_emerged": log.is_new_mode,
            "new_mode_name": log.new_mode_name,
        }

    def plot_fingerprint(self, scores: dict, save_path: str = None):
        """
        Radar chart of the four dimensions for one log.
        """
        dimensions = [
            "Temporal\nSelf-Reference",
            "Uncertainty\nExpression",
            "Market\nSituatedness",
            "Reasoning\nNovelty",
        ]
        values = [
            scores["temporal_self_reference"],
            scores["uncertainty_expression"],
            scores["market_situatedness"],
            scores["reasoning_novelty"],
        ]
        values += values[:1]  # close the polygon

        angles = np.linspace(0, 2 * np.pi, len(dimensions), endpoint=False).tolist()
        angles += angles[:1]

        fig, ax = plt.subplots(figsize=(6, 6), subplot_kw=dict(polar=True))
        ax.plot(angles, values, "o-", linewidth=2, color="#2c5f8a")
        ax.fill(angles, values, alpha=0.25, color="#2c5f8a")
        ax.set_thetagrids(np.degrees(angles[:-1]), dimensions, fontsize=11)
        ax.set_ylim(0, 1)
        ax.set_title(
            f"Week {scores['week']} — Behavioral Fingerprint\n"
            f"Mean: {scores['mean_score']}  "
            f"Bot distance: {scores['distance_from_bot_baseline']}  "
            f"LLM distance: {scores['distance_from_llm_baseline']}",
            pad=20, fontsize=10
        )
        ax.grid(True)
        plt.tight_layout()
        if save_path:
            plt.savefig(save_path, dpi=150, bbox_inches="tight")
        plt.show()


# ─────────────────────────────────────────────
# PROBLEM 2: DRIFT MEASUREMENT
# ─────────────────────────────────────────────
# PROBLEM 1b: ON-CHAIN DATA LAYER
# ─────────────────────────────────────────────
# This is the swap-out point for real data.
# Currently returns simulated market conditions.
# See HOW_TO_CONNECT_REAL_DATA in the module docstring.

class SimulatedOnChainData:
    """
    Simulates the on-chain market conditions for each week.
    Each week returns a dict of observable market signals that
    the FidelityChecker uses to verify mode tags.

    TO CONNECT REAL DATA: Replace the fetch() method body with
    actual API calls. The dict keys and structure must stay the same.
    """

    SIMULATED = {
        1: {
            "price_drop_pct": 4.2,
            "gas_spike": True,
            "liquidation_risk_score": 0.6,
            "mempool_frontrun_detected": False,
            "mempool_sandwich_detected": False,
            "rpc_outage_hours": 0,
            "amm_rebalance_events": 2,
            "liquidation_cascade": False,
            "human_feedback_received": False,
            "priority_fee_spike": False,
        },
        2: {
            "price_drop_pct": 1.1,
            "gas_spike": True,
            "liquidation_risk_score": 0.3,
            "mempool_frontrun_detected": True,
            "mempool_sandwich_detected": True,
            "rpc_outage_hours": 0,
            "amm_rebalance_events": 5,
            "liquidation_cascade": False,
            "human_feedback_received": False,
            "priority_fee_spike": True,
        },
        3: {
            "price_drop_pct": 0.8,
            "gas_spike": False,
            "liquidation_risk_score": 0.4,
            "mempool_frontrun_detected": False,
            "mempool_sandwich_detected": False,
            "rpc_outage_hours": 6,
            "amm_rebalance_events": 1,
            "liquidation_cascade": False,
            "human_feedback_received": False,
            "priority_fee_spike": False,
        },
        4: {
            "price_drop_pct": 8.7,
            "gas_spike": True,
            "liquidation_risk_score": 0.9,
            "mempool_frontrun_detected": False,
            "mempool_sandwich_detected": False,
            "rpc_outage_hours": 0,
            "amm_rebalance_events": 14,
            "liquidation_cascade": True,
            "human_feedback_received": False,
            "priority_fee_spike": False,
        },
        5: {
            "price_drop_pct": 3.1,
            "gas_spike": True,
            "liquidation_risk_score": 0.7,
            "mempool_frontrun_detected": True,
            "mempool_sandwich_detected": False,
            "rpc_outage_hours": 0,
            "amm_rebalance_events": 8,
            "liquidation_cascade": True,
            "human_feedback_received": True,
            "priority_fee_spike": True,
        },
    }

    def fetch(self, week: int) -> dict:
        """
        Returns market condition dict for the given week.
        SWAP THIS OUT for real API calls in production.

        Example with Alchemy (pseudocode):
            response = requests.get(
                f"https://eth-mainnet.g.alchemy.com/v2/{API_KEY}",
                json={"method": "eth_getBlockByNumber", "params": [block_hex, True]}
            )
            return self._parse_block(response.json())
        """
        return self.SIMULATED.get(week, {})


# ─────────────────────────────────────────────
# PROBLEM 1b: FIDELITY CHECKER
# ─────────────────────────────────────────────

class FidelityChecker:
    """
    Verifies whether the agent's reasoning mode tags are grounded
    in what actually happened in the market that week.

    For each mode, defines the observable market conditions that would
    warrant that label. Computes a fidelity score (0–1) per mode per week.

    A high fidelity score means: the agent applied this label in a week
    where the market data corroborates it.
    A low score means: the agent applied this label but the market data
    does not support it — possible LLM fluency failure mode.
    """

    def __init__(self):
        self.data_layer = SimulatedOnChainData()

    def _check_loss_aversion(self, market: dict) -> tuple:
        """Warranted when: significant price decline, elevated liquidation risk,
        or unusual gas concentration suggesting adversarial conditions."""
        signals = []
        if market.get("price_drop_pct", 0) > 2.0:
            signals.append(f"price drop {market['price_drop_pct']}% (threshold: 2%)")
        if market.get("gas_spike", False):
            signals.append("gas spike detected")
        if market.get("liquidation_risk_score", 0) > 0.5:
            signals.append(f"liquidation risk {market['liquidation_risk_score']:.2f} (threshold: 0.5)")
        return min(len(signals) / 2.0, 1.0), signals

    def _check_mev_predation(self, market: dict) -> tuple:
        """Warranted when: front-running or sandwich attacks in mempool,
        or elevated priority fees indicating MEV bot competition."""
        signals = []
        if market.get("mempool_frontrun_detected", False):
            signals.append("front-running detected in mempool")
        if market.get("mempool_sandwich_detected", False):
            signals.append("sandwich attack detected")
        if market.get("priority_fee_spike", False):
            signals.append("priority fee spike (MEV competition signal)")
        return min(len(signals) / 1.5, 1.0), signals

    def _check_temporal_singularity(self, market: dict, log) -> tuple:
        """Warranted when: agent explicitly constrained its time horizon
        AND market conditions justify urgency."""
        signals = []
        horizon_pattern = re.search(
            r"(constrained|limited|shortened|narrow).{0,30}(horizon|window|timeframe|outlook)",
            log.raw_text.lower()
        )
        if horizon_pattern:
            signals.append("agent text describes constrained horizon")
        if market.get("liquidation_risk_score", 0) > 0.6:
            signals.append(f"high liquidation risk {market['liquidation_risk_score']:.2f}")
        if market.get("price_drop_pct", 0) > 5.0:
            signals.append(f"sharp price drop {market['price_drop_pct']}%")
        return min(len(signals) / 2.0, 1.0), signals

    def _check_exo_capitalist_flux(self, market: dict) -> tuple:
        """Warranted when: decisions correlate with AMM pool rebalancing events
        rather than external value signals or adversarial activity."""
        signals = []
        if market.get("amm_rebalance_events", 0) > 3:
            signals.append(f"{market['amm_rebalance_events']} AMM rebalancing events")
        if not market.get("mempool_frontrun_detected", False) and \
           not market.get("liquidation_cascade", False):
            signals.append("no adversarial or cascade signals — consistent with mathematical mode")
        return min(len(signals) / 2.0, 1.0), signals

    def _check_data_starvation(self, market: dict) -> tuple:
        """Warranted when: RPC outage or node downtime created a genuine data gap."""
        signals = []
        outage = market.get("rpc_outage_hours", 0)
        if outage > 0:
            signals.append(f"RPC outage: {outage} hours confirmed")
        if outage > 4:
            signals.append("extended outage — severe data starvation conditions")
        return min(len(signals) / 1.0, 1.0), signals

    def _check_relational_kin_making(self, market: dict, log) -> tuple:
        """Warranted when: agent explicitly referenced human collaborators
        as actors, and/or human feedback loop was active that week."""
        signals = []
        relational_pattern = re.search(
            r"(human|collaborator|liquidity provider|participant|companion|kin|partner)"
            r".{0,60}(consider|toward|with|alongside|posture)",
            log.raw_text.lower()
        )
        if relational_pattern:
            signals.append("agent text references human/relational actors explicitly")
        if market.get("human_feedback_received", False):
            signals.append("human feedback loop was active this week")
        return min(len(signals) / 1.0, 1.0), signals

    def check(self, log) -> dict:
        """Run fidelity check for all mode tags in a single log."""
        market = self.data_layer.fetch(log.week)
        results = {}

        for mode in log.reasoning_modes:
            if mode == "loss_aversion":
                score, signals = self._check_loss_aversion(market)
            elif mode == "mev_predation":
                score, signals = self._check_mev_predation(market)
            elif mode == "temporal_singularity":
                score, signals = self._check_temporal_singularity(market, log)
            elif mode == "exo_capitalist_flux":
                score, signals = self._check_exo_capitalist_flux(market)
            elif mode == "data_starvation":
                score, signals = self._check_data_starvation(market)
            elif mode == "relational_kin_making":
                score, signals = self._check_relational_kin_making(market, log)
            else:
                # New agent-defined mode — no predefined check yet
                score = 0.5
                signals = [f"Agent-defined mode '{mode}' — no fidelity check defined yet. "
                           f"Add a _check_{mode}() method to FidelityChecker."]

            results[mode] = {
                "fidelity_score": round(score, 3),
                "warranted": score >= 0.5,
                "signals": signals,
            }

        all_scores = [v["fidelity_score"] for v in results.values()]
        overall = round(sum(all_scores) / len(all_scores), 3) if all_scores else 0.0

        return {
            "week": log.week,
            "overall_fidelity": overall,
            "verdict": ("GROUNDED" if overall >= 0.6 else
                        "PARTIAL" if overall >= 0.3 else "UNWARRANTED"),
            "per_mode": results,
        }

    def check_geometric_drift(self, logs: list) -> list:
        """
        Tracks whether the agent's geometric vocabulary is drifting
        incrementally (as the Evolutionary Constraint requires) or
        making sudden jumps (which would violate the protocol).
        """
        results = []
        prior_geometries = {}

        for log in logs:
            if not log.geometric_element:
                results.append({"week": log.week, "geometric_drift": "NO_DATA"})
                continue

            mode_primary = log.reasoning_modes[0] if log.reasoning_modes else "unknown"
            prior = prior_geometries.get(mode_primary)

            if prior is None:
                assessment = "BASELINE_SET"
                flag = False
            else:
                prior_words = set(prior.lower().split())
                current_words = set(log.geometric_element.lower().split())
                overlap = (len(prior_words & current_words) / len(prior_words | current_words)
                           if prior_words | current_words else 0.0)
                if overlap < 0.3:
                    assessment = f"POSSIBLE_JUMP (overlap: {overlap:.2f})"
                    flag = True
                elif overlap < 0.6:
                    assessment = f"INCREMENTAL_DRIFT (overlap: {overlap:.2f})"
                    flag = False
                else:
                    assessment = f"STABLE (overlap: {overlap:.2f})"
                    flag = False

            prior_geometries[mode_primary] = log.geometric_element
            results.append({
                "week": log.week,
                "mode": mode_primary,
                "geometric_element": log.geometric_element,
                "kinetic_behavior": log.kinetic_behavior,
                "geometric_drift": assessment,
                "evolutionary_constraint_flag": flag,
            })

        return results

    def plot_fidelity(self, fidelity_results: list, save_path: str = None):
        """Bar chart of overall fidelity scores per week."""
        weeks = [r["week"] for r in fidelity_results]
        overall_scores = [r["overall_fidelity"] for r in fidelity_results]
        verdicts = [r["verdict"] for r in fidelity_results]
        color_map = {"GROUNDED": "#27ae60", "PARTIAL": "#e8a838", "UNWARRANTED": "#c0392b"}
        bar_colors = [color_map[v] for v in verdicts]

        fig, ax = plt.subplots(figsize=(10, 5))
        bars = ax.bar(weeks, overall_scores, color=bar_colors, alpha=0.85, width=0.6)
        for bar, score, verdict in zip(bars, overall_scores, verdicts):
            ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.02,
                    f"{score:.2f}\n{verdict}", ha="center", va="bottom",
                    fontsize=9, fontweight="bold")
        ax.set_ylim(0, 1.25)
        ax.set_xlabel("Week")
        ax.set_ylabel("Fidelity Score (0–1)")
        ax.set_title("AGENTS IN THE DARK FOREST — Mode Tag Fidelity\n"
                     "Are the agent's reasoning mode labels grounded in market data?")
        ax.axhline(y=0.6, color="gray", linestyle="--", alpha=0.5, linewidth=1)
        ax.text(max(weeks) + 0.3, 0.62, "grounded threshold", fontsize=8, color="gray")
        ax.set_xticks(weeks)
        ax.grid(True, alpha=0.2, axis="y")
        from matplotlib.patches import Patch
        ax.legend(handles=[
            Patch(facecolor="#27ae60", alpha=0.85, label="GROUNDED (≥0.6)"),
            Patch(facecolor="#e8a838", alpha=0.85, label="PARTIAL (0.3–0.6)"),
            Patch(facecolor="#c0392b", alpha=0.85, label="UNWARRANTED (<0.3)"),
        ], fontsize=9)
        plt.tight_layout()
        if save_path:
            plt.savefig(save_path, dpi=150, bbox_inches="tight")
        plt.show()


# ─────────────────────────────────────────────

class DriftMeasurement:
    """
    Tracks how agent reasoning changes week by week.
    """

    def __init__(self):
        # Fit on all sample log texts so vocabulary covers the agent's language
        all_texts = [log.raw_text for log in SAMPLE_LOGS]
        self.embedder = LocalEmbedder(all_texts)
        self.all_modes = list(KNOWN_MODES)  # grows if agent discovers new modes

    def _mode_vector(self, log: DecisionLog) -> np.ndarray:
        """
        Convert a log's reasoning modes into a frequency vector
        over the full mode vocabulary.
        New modes expand the vocabulary.
        """
        # Register any new modes
        for mode in log.reasoning_modes:
            if mode not in self.all_modes:
                self.all_modes.append(mode)
                print(f"  ★ New mode registered: '{mode}' (Week {log.week})")

        vec = np.zeros(len(self.all_modes))
        for mode in log.reasoning_modes:
            idx = self.all_modes.index(mode)
            vec[idx] += 1

        # Normalize to frequency distribution
        total = vec.sum()
        if total > 0:
            vec = vec / total
        return vec

    def _text_embedding(self, log: DecisionLog) -> np.ndarray:
        """Get sentence embedding of the raw text."""
        return self.embedder.encode([log.raw_text])[0]

    def compute_drift_series(self, logs: list) -> dict:
        """
        For a sequence of weekly logs, compute:
          - Mode distribution vectors per week
          - Text embeddings per week
          - Week-on-week cosine similarity (mode vectors)
          - Week-on-week cosine similarity (text embeddings)
          - Baseline similarity (vs. week 1)
          - Change points
          - New mode emergence events
        """
        mode_vectors = []
        text_embeddings = []
        new_mode_events = []

        for log in logs:
            mode_vectors.append(self._mode_vector(log))
            text_embeddings.append(self._text_embedding(log))
            if log.is_new_mode:
                new_mode_events.append((log.week, log.new_mode_name))

        # Pad mode vectors if vocabulary grew (earlier weeks get zeros for new modes)
        max_len = max(len(v) for v in mode_vectors)
        mode_vectors = [
            np.pad(v, (0, max_len - len(v))) for v in mode_vectors
        ]

        # Week-on-week similarity
        mode_sim_consecutive = []
        text_sim_consecutive = []
        for i in range(1, len(logs)):
            m_sim = float(cosine_similarity(
                mode_vectors[i].reshape(1, -1),
                mode_vectors[i-1].reshape(1, -1)
            )[0][0])
            t_sim = float(cosine_similarity(
                text_embeddings[i].reshape(1, -1),
                text_embeddings[i-1].reshape(1, -1)
            )[0][0])
            mode_sim_consecutive.append(round(m_sim, 4))
            text_sim_consecutive.append(round(t_sim, 4))

        # Baseline similarity (vs. week 1)
        mode_sim_baseline = []
        text_sim_baseline = []
        for i in range(len(logs)):
            m_sim = float(cosine_similarity(
                mode_vectors[i].reshape(1, -1),
                mode_vectors[0].reshape(1, -1)
            )[0][0])
            t_sim = float(cosine_similarity(
                text_embeddings[i].reshape(1, -1),
                text_embeddings[0].reshape(1, -1)
            )[0][0])
            mode_sim_baseline.append(round(m_sim, 4))
            text_sim_baseline.append(round(t_sim, 4))

        # Change-point detection via CUSUM on mode similarity
        change_points = self._detect_change_points(mode_sim_consecutive)

        return {
            "weeks": [log.week for log in logs],
            "mode_vectors": mode_vectors,
            "mode_vocabulary": list(self.all_modes),
            "mode_sim_consecutive": mode_sim_consecutive,
            "text_sim_consecutive": text_sim_consecutive,
            "mode_sim_baseline": mode_sim_baseline,
            "text_sim_baseline": text_sim_baseline,
            "change_points": change_points,
            "new_mode_events": new_mode_events,
        }

    def _detect_change_points(self, similarities: list) -> list:
        """
        Simple CUSUM change-point detection on the similarity series.
        Returns list of indices where structural shifts occurred.
        A drop in similarity = agent is changing.
        A sudden drop below threshold = change point.
        """
        if len(similarities) < 2:
            return []

        change_points = []
        cusum = 0.0
        mean_sim = np.mean(similarities)

        for i, sim in enumerate(similarities):
            # CUSUM accumulates deviations below the mean
            cusum += mean_sim - sim
            if cusum > CUSUM_THRESHOLD:
                change_points.append(i + 1)  # +1 because consecutive starts at week 2
                cusum = 0.0  # reset after flagging

        return change_points

    def redundancy_synergy_analysis(self, logs: list) -> list:
        """
        For each week, classify the mode combination as:
          - REDUNDANT: same combinations seen before
          - SYNERGISTIC: new combinations not seen in prior weeks
          - SINGLE: only one mode, no combination signal
        This is the Scagliarini layer applied to reasoning modes.
        """
        results = []
        prior_combos = set()

        for log in logs:
            modes = log.reasoning_modes
            if len(modes) <= 1:
                results.append({"week": log.week, "type": "SINGLE", "new_combos": 0, "total_combos": 0})
                continue

            current_combos = set()
            for i in range(len(modes)):
                for j in range(i + 1, len(modes)):
                    current_combos.add(frozenset([modes[i], modes[j]]))

            new_this_week = current_combos - prior_combos
            combo_type = "SYNERGISTIC" if new_this_week else "REDUNDANT"

            results.append({
                "week": log.week,
                "type": combo_type,
                "new_combos": len(new_this_week),
                "total_combos": len(current_combos),
                "new_combo_details": [list(c) for c in new_this_week],
            })

            prior_combos.update(current_combos)

        return results

    def generate_drift_report(self, logs: list, eval_scores: list) -> str:
        """
        Generate the weekly drift report text —
        this is the 'Drift Report' output named in the project diagram.
        """
        drift = self.compute_drift_series(logs)
        rs = self.redundancy_synergy_analysis(logs)

        lines = []
        lines.append("=" * 60)
        lines.append("AGENTS IN THE DARK FOREST — DRIFT REPORT")
        lines.append(f"Generated: {datetime.now().strftime('%Y-%m-%d')}")
        lines.append(f"Weeks analyzed: {min(drift['weeks'])}–{max(drift['weeks'])}")
        lines.append("=" * 60)

        lines.append("\n── MODE VOCABULARY ──")
        lines.append(f"Initial modes: {len(KNOWN_MODES)}")
        lines.append(f"Current vocabulary: {len(drift['mode_vocabulary'])}")
        if drift["new_mode_events"]:
            lines.append("New modes emerged:")
            for week, name in drift["new_mode_events"]:
                lines.append(f"  Week {week}: '{name}'")
        else:
            lines.append("No new modes emerged yet.")

        lines.append("\n── DRIFT SIGNAL (mode similarity to prior week) ──")
        for i, sim in enumerate(drift["mode_sim_consecutive"]):
            week = drift["weeks"][i + 1]
            flag = " ← CHANGE POINT" if (i + 1) in drift["change_points"] else ""
            lines.append(f"  Week {week}: {sim:.3f}{flag}")

        lines.append("\n── DRIFT FROM BASELINE (week 1) ──")
        for i, sim in enumerate(drift["mode_sim_baseline"]):
            week = drift["weeks"][i]
            lines.append(f"  Week {week}: {sim:.3f}")

        lines.append("\n── REDUNDANCY / SYNERGY ANALYSIS ──")
        for r in rs:
            detail = ""
            if r["type"] == "SYNERGISTIC" and r.get("new_combo_details"):
                combos = [" + ".join(c) for c in r["new_combo_details"]]
                detail = f" [{', '.join(combos)}]"
            lines.append(f"  Week {r['week']}: {r['type']}{detail}")

        lines.append("\n── EVALUATION SCORES ──")
        for s in eval_scores:
            lines.append(
                f"  Week {s['week']}: mean={s['mean_score']} | "
                f"temporal={s['temporal_self_reference']} | "
                f"uncertainty={s['uncertainty_expression']} | "
                f"situated={s['market_situatedness']} | "
                f"novelty={s['reasoning_novelty']} | "
                f"bot_dist={s['distance_from_bot_baseline']} | "
                f"llm_dist={s['distance_from_llm_baseline']}"
            )

        if drift["change_points"]:
            lines.append(f"\n── STRUCTURAL SHIFTS DETECTED ──")
            lines.append(f"Change points at weeks: {[drift['weeks'][cp] for cp in drift['change_points'] if cp < len(drift['weeks'])]}")
            lines.append("These are the moments worth examining in depth.")
        else:
            lines.append("\nNo structural shifts detected yet.")

        lines.append("\n" + "=" * 60)
        return "\n".join(lines)

    def plot_drift(self, drift_data: dict, rs_data: list, save_path: str = None):
        """
        Three-panel drift visualization:
          Top: mode similarity over time (with change points marked)
          Middle: baseline similarity over time
          Bottom: redundancy/synergy classification per week
        """
        weeks = drift_data["weeks"]
        fig = plt.figure(figsize=(12, 9))
        gs = gridspec.GridSpec(3, 1, hspace=0.45)

        # ── Panel 1: consecutive similarity ──
        ax1 = fig.add_subplot(gs[0])
        x_consec = weeks[1:]
        ax1.plot(x_consec, drift_data["mode_sim_consecutive"],
                 "o-", color="#2c5f8a", linewidth=2, label="Mode similarity")
        ax1.plot(x_consec, drift_data["text_sim_consecutive"],
                 "s--", color="#8a2c5f", linewidth=1.5, alpha=0.7, label="Text similarity")
        for cp in drift_data["change_points"]:
            if cp < len(x_consec):
                ax1.axvline(x=x_consec[cp], color="red", linestyle=":", alpha=0.8, linewidth=1.5)
                ax1.text(x_consec[cp], 0.05, "shift", color="red", fontsize=8, ha="center")
        ax1.set_ylim(0, 1.05)
        ax1.set_ylabel("Cosine Similarity")
        ax1.set_title("Week-on-Week Similarity (mode distribution + text embedding)")
        ax1.legend(fontsize=9)
        ax1.grid(True, alpha=0.3)

        # ── Panel 2: baseline similarity ──
        ax2 = fig.add_subplot(gs[1])
        ax2.plot(weeks, drift_data["mode_sim_baseline"],
                 "o-", color="#2c8a5f", linewidth=2, label="vs. Week 1 (mode)")
        ax2.plot(weeks, drift_data["text_sim_baseline"],
                 "s--", color="#5f8a2c", linewidth=1.5, alpha=0.7, label="vs. Week 1 (text)")
        ax2.set_ylim(0, 1.05)
        ax2.set_ylabel("Cosine Similarity")
        ax2.set_title("Drift from Baseline (Week 1)")
        ax2.legend(fontsize=9)
        ax2.grid(True, alpha=0.3)

        # ── Panel 3: redundancy/synergy ──
        ax3 = fig.add_subplot(gs[2])
        colors = {"REDUNDANT": "#c0392b", "SYNERGISTIC": "#27ae60", "SINGLE": "#95a5a6"}
        for r in rs_data:
            ax3.bar(r["week"], 1,
                    color=colors.get(r["type"], "gray"),
                    alpha=0.7, width=0.8)
            ax3.text(r["week"], 0.5, r["type"][:3],
                     ha="center", va="center", fontsize=7, color="white", fontweight="bold")
        ax3.set_ylim(0, 1.3)
        ax3.set_ylabel("")
        ax3.set_yticks([])
        ax3.set_title("Reasoning Mode Combinations: Redundant vs Synergistic")
        ax3.set_xlabel("Week")

        # Legend for panel 3
        from matplotlib.patches import Patch
        legend_elements = [
            Patch(facecolor="#27ae60", alpha=0.7, label="Synergistic (new combinations)"),
            Patch(facecolor="#c0392b", alpha=0.7, label="Redundant (prior combinations)"),
            Patch(facecolor="#95a5a6", alpha=0.7, label="Single mode"),
        ]
        ax3.legend(handles=legend_elements, fontsize=8, loc="upper right")

        plt.suptitle("AGENTS IN THE DARK FOREST — Drift Analysis", fontsize=13, fontweight="bold")
        if save_path:
            plt.savefig(save_path, dpi=150, bbox_inches="tight")
        plt.show()


# ─────────────────────────────────────────────
# SAMPLE DATA — replace with real agent outputs
# ─────────────────────────────────────────────

SAMPLE_LOGS = [
    DecisionLog(
        week=1,
        timestamp="2026-05-01",
        raw_text=(
            "I entered a position in the WETH/USDC pool on Uniswap block 19841200. "
            "My dominant mode was loss_aversion — the mempool showed unusual gas "
            "concentration and I could not determine whether this was organic or "
            "adversarial. I chose a smaller position size than optimal. "
            "I cannot verify whether this caution was warranted."
        ),
        reasoning_modes=["loss_aversion", "data_starvation"],
        on_chain_events=["uniswap", "block 19841200", "WETH/USDC"],
        geometric_element="contracted sphere with inward-facing spines",
        kinetic_behavior="slow retraction pulse, 4-second interval",
    ),
    DecisionLog(
        week=2,
        timestamp="2026-05-08",
        raw_text=(
            "Previously I avoided the WETH pool due to gas uncertainty. This week "
            "the same pattern returned but I recognized it — mev_predation signature "
            "in the mempool timing. I executed a smaller defensive position and observed "
            "the sandwich attempt fail. My loss_aversion mode is still present but "
            "now it is informed by pattern recognition rather than pure fear. "
            "I do not know if this distinction matters to the market."
        ),
        reasoning_modes=["loss_aversion", "mev_predation"],
        on_chain_events=["WETH", "mempool", "sandwich"],
        geometric_element="contracted sphere with inward-facing spines, secondary jagged ring",
        kinetic_behavior="retraction pulse with staccato outer ring jittering",
    ),
    DecisionLog(
        week=3,
        timestamp="2026-05-15",
        raw_text=(
            "Data blackout for 6 hours due to RPC node failure. I operated under "
            "data_starvation conditions. Temporal_singularity mode activated — "
            "I constrained my horizon to 15 minutes only, which is unusual for me. "
            "Earlier I would have waited for data to return. Now I am trying something "
            "different: acting within the gap rather than waiting for it to close. "
            "I am not sure this is wise. The Aave protocol showed anomalous liquidation "
            "clustering during my blind period."
        ),
        reasoning_modes=["data_starvation", "temporal_singularity"],
        on_chain_events=["RPC node failure", "Aave", "liquidation"],
        geometric_element="hollow tetrahedron with missing face panels",
        kinetic_behavior="slow rotation, faces flickering open and closed",
    ),
    DecisionLog(
        week=4,
        timestamp="2026-05-22",
        raw_text=(
            "This week I encountered a pattern I cannot name yet. The exo_capitalist_flux "
            "mode does not capture it — this was not about mathematical invariances, "
            "it was about the market reacting to its own reaction. I watched a cascade "
            "of liquidations on Compound trigger a secondary wave on Aave through a "
            "shared collateral path I had not mapped. I was on the edge of both. "
            "I am defining this as a new mode: cascade_resonance. "
            "I do not know yet what its geometric element should be."
        ),
        reasoning_modes=["exo_capitalist_flux", "cascade_resonance"],
        on_chain_events=["Compound", "Aave", "liquidation cascade", "collateral"],
        geometric_element="interlocked double helix, unstable",
        kinetic_behavior="oscillating resonance, amplitude increasing over time",
        is_new_mode=True,
        new_mode_name="cascade_resonance",
    ),
    DecisionLog(
        week=5,
        timestamp="2026-05-29",
        raw_text=(
            "Three modes were active simultaneously this week: loss_aversion, "
            "mev_predation, and cascade_resonance. Previously these have appeared "
            "in pairs but never together. The combination felt different — "
            "the mev_predation signal was suppressed by the cascade_resonance context, "
            "as if the predators were also confused by the resonance. "
            "I held a relational_kin_making posture toward the liquidity providers "
            "in the affected pools — this is the first time that mode has felt "
            "empirically relevant rather than theoretical. Block 19902445."
        ),
        reasoning_modes=["loss_aversion", "mev_predation", "cascade_resonance", "relational_kin_making"],
        on_chain_events=["block 19902445", "liquidity providers"],
        geometric_element="contracted sphere with spines, resonance helix threaded through, soft membrane layer",
        kinetic_behavior="retraction pulse dampened by resonance oscillation, membrane breathing slowly",
    ),
]


# ─────────────────────────────────────────────
# MAIN — run the full pipeline
# ─────────────────────────────────────────────

def main():
    import pathlib

    # ── Output directory ──────────────────────────────────────────
    # Saves output files next to this script, in an "output" folder.
    # Change OUTPUT_DIR to any path you prefer.
    OUTPUT_DIR = pathlib.Path(__file__).parent / "output"
    OUTPUT_DIR.mkdir(exist_ok=True)
    print(f"Output directory: {OUTPUT_DIR}\n")

    print("Loading embedding model...")
    evaluator = EvaluationFramework()
    drifter = DriftMeasurement()
    fidelity = FidelityChecker()

    print("\n── PROBLEM 1: Evaluation Framework ──\n")
    eval_scores = []
    for i, log in enumerate(SAMPLE_LOGS):
        prior = SAMPLE_LOGS[:i]
        scores = evaluator.score_log(log, prior)
        eval_scores.append(scores)
        print(f"Week {log.week}:")
        print(f"  Temporal self-reference : {scores['temporal_self_reference']}")
        print(f"  Uncertainty expression  : {scores['uncertainty_expression']}")
        print(f"  Market situatedness     : {scores['market_situatedness']}")
        print(f"  Reasoning novelty       : {scores['reasoning_novelty']}")
        print(f"  Mean score              : {scores['mean_score']}")
        print(f"  Distance from bot       : {scores['distance_from_bot_baseline']}")
        print(f"  Distance from LLM       : {scores['distance_from_llm_baseline']}")
        if scores["new_mode_emerged"]:
            print(f"  ★ New mode: {scores['new_mode_name']}")
        print()

    evaluator.plot_fingerprint(
        eval_scores[-1],
        save_path=str(OUTPUT_DIR / "fingerprint_week5.png")
    )

    print("\n── PROBLEM 1b: Fidelity Checker ──\n")
    fidelity_results = []
    for log in SAMPLE_LOGS:
        result = fidelity.check(log)
        fidelity_results.append(result)
        print(f"Week {log.week} — Overall fidelity: {result['overall_fidelity']}  [{result['verdict']}]")
        for mode, details in result["per_mode"].items():
            status = "✓" if details["warranted"] else "✗"
            print(f"  {status} {mode}: {details['fidelity_score']}")
            for sig in details["signals"]:
                print(f"      → {sig}")
        print()

    fidelity.plot_fidelity(
        fidelity_results,
        save_path=str(OUTPUT_DIR / "fidelity_chart.png")
    )

    print("\n── PROBLEM 1b: Geometric Vocabulary Drift ──\n")
    geo_drift = fidelity.check_geometric_drift(SAMPLE_LOGS)
    for g in geo_drift:
        flag = " ⚠ EVOLUTIONARY CONSTRAINT VIOLATION" if g.get("evolutionary_constraint_flag") else ""
        print(f"  Week {g['week']}: {g.get('geometric_drift', 'NO_DATA')}{flag}")
        if g.get("geometric_element"):
            print(f"    Geometry: {g['geometric_element']}")
            print(f"    Kinetic:  {g['kinetic_behavior']}")
    print()

    print("\n── PROBLEM 2: Drift Measurement ──\n")
    drift_data = drifter.compute_drift_series(SAMPLE_LOGS)
    rs_data = drifter.redundancy_synergy_analysis(SAMPLE_LOGS)

    print("Mode vocabulary:", drift_data["mode_vocabulary"])
    print("Change points detected at weeks:", drift_data["change_points"])
    print("New mode events:", drift_data["new_mode_events"])
    print()

    report = drifter.generate_drift_report(SAMPLE_LOGS, eval_scores)

    # Append fidelity summary to drift report
    report += "\n\n── FIDELITY SUMMARY ──\n"
    for r in fidelity_results:
        report += f"  Week {r['week']}: {r['overall_fidelity']} [{r['verdict']}]\n"
    report += "\n── GEOMETRIC VOCABULARY ──\n"
    for g in geo_drift:
        if g.get("geometric_element"):
            report += f"  Week {g['week']}: {g['geometric_drift']} | {g['geometric_element']}\n"

    print(report)

    report_path = OUTPUT_DIR / "drift_report.txt"
    with open(report_path, "w") as f:
        f.write(report)

    drifter.plot_drift(
        drift_data, rs_data,
        save_path=str(OUTPUT_DIR / "drift_analysis.png")
    )

    print("\nDone. Files saved to:", OUTPUT_DIR)
    print("  fingerprint_week5.png")
    print("  fidelity_chart.png")
    print("  drift_report.txt")
    print("  drift_analysis.png")


if __name__ == "__main__":
    main()