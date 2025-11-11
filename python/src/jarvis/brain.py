"""
JARVIS Brain - Core Intelligence

The main orchestration and intelligence layer for JARVIS.
Coordinates specialist agents, manages knowledge, and provides intelligent assistance.

Phase 1.5 Enhancements:
- Smart model selection (Haiku 4.5 for most tasks, Sonnet 4.5 for complex tasks)
- Response caching to reduce API costs
- Cost tracking and optimization
"""

import asyncio
import hashlib
import json
import logging
import os
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import httpx
from pydantic import BaseModel

from .personality import JARVISPersonality

logger = logging.getLogger(__name__)


class Intent(BaseModel):
    """Represents interpreted user intent."""
    type: str  # information, agent_task, system_control, knowledge_management, general
    details: str
    confidence: float
    complexity: float = 0.5  # 0.0-1.0, determines which model to use
    suggested_agents: List[str] = []
    requires_knowledge: bool = False


class Ring(BaseModel):
    """Represents a specialist agent (Ring)."""
    id: str
    name: str
    role: str
    prompt_path: str
    capabilities: List[str]
    triggers: List[str]


class CachedResponse(BaseModel):
    """Cached API response."""
    response: Any
    timestamp: datetime
    model: str


class JARVIS:
    """
    JARVIS - Just A Rather Very Intelligent System

    Your personal AI assistant for development work.
    Inspired by Tony Stark's AI assistant, JARVIS coordinates
    specialist agents, manages your knowledge base, and provides
    proactive assistance across all your development work.

    Phase 1.5 Features:
    - Cost-optimized model selection (Haiku 4.5 vs Sonnet 4.5)
    - Response caching to reduce API calls
    - Smart complexity detection
    """

    def __init__(self, user_name: str = None):
        """Initialize JARVIS."""
        self.user_name = user_name or os.getenv("JARVIS_USER_NAME", "Sir")
        self.personality = JARVISPersonality(self.user_name)

        # Service URLs
        self.archon_mcp_url = os.getenv("ARCHON_MCP_URL", "http://localhost:8051")
        self.archon_server_url = os.getenv("ARCHON_SERVER_URL", "http://localhost:8181")
        self.work_orders_url = os.getenv("AGENT_WORK_ORDERS_URL", "http://localhost:8053")

        # API Keys
        self.anthropic_api_key = os.getenv("ANTHROPIC_API_KEY")
        self.openai_api_key = os.getenv("OPENAI_API_KEY")

        # Model Configuration (Cost Optimization)
        self.default_model = os.getenv("JARVIS_DEFAULT_MODEL", "claude-3-5-haiku-20241022")
        self.advanced_model = os.getenv("JARVIS_ADVANCED_MODEL", "claude-3-5-sonnet-20241022")
        self.complexity_threshold = float(os.getenv("JARVIS_COMPLEXITY_THRESHOLD", "0.8"))
        self.enable_cache = os.getenv("JARVIS_ENABLE_CACHE", "true").lower() == "true"

        # Response Cache
        self.cache: Dict[str, CachedResponse] = {}
        self.cache_ttl = timedelta(hours=1)  # Cache responses for 1 hour

        # Cost Tracking
        self.api_calls: Dict[str, int] = {"haiku": 0, "sonnet": 0}
        self.cache_hits = 0

        # State
        self.conversation_history: List[Dict] = []
        self.active_agents: List[str] = []
        self.system_status: Dict = {}
        self.monitoring_active = False

        # Load agent registry
        self.rings: Dict[str, Ring] = {}
        self._load_rings()

        logger.info(f"JARVIS initialized for {self.user_name}")
        logger.info(f"Default model: {self.default_model}")
        logger.info(f"Advanced model: {self.advanced_model}")
        logger.info(f"Complexity threshold: {self.complexity_threshold}")
        logger.info(f"Cache enabled: {self.enable_cache}")

    def _load_rings(self):
        """Load BMAD agent registry."""
        # For Phase 1, we'll use a simplified registry
        # In Phase 2, we'll load from bmad-integration/agent-registry.json

        # Default Project ORTRTA rings
        default_rings = [
            {
                "id": "nenya",
                "name": "Nenya",
                "role": "Product Manager",
                "prompt_path": "/app/bmad-integration/agents/nenya.md",
                "capabilities": ["requirements analysis", "stakeholder mapping", "user stories"],
                "triggers": ["requirements", "stakeholders", "user stories", "prioritization"]
            },
            {
                "id": "vilya",
                "name": "Vilya",
                "role": "System Architect",
                "prompt_path": "/app/bmad-integration/agents/vilya.md",
                "capabilities": ["system design", "architecture patterns", "tech stack decisions"],
                "triggers": ["architecture", "design", "tech stack", "patterns", "system"]
            },
            {
                "id": "narya",
                "name": "Narya",
                "role": "Research Analyst",
                "prompt_path": "/app/bmad-integration/agents/narya.md",
                "capabilities": ["research", "competitive analysis", "feasibility studies"],
                "triggers": ["research", "analyze", "compare", "feasibility", "investigate"]
            }
        ]

        for ring_data in default_rings:
            ring = Ring(**ring_data)
            self.rings[ring.id] = ring

        logger.info(f"Loaded {len(self.rings)} specialist rings")

    def _get_cache_key(self, prompt: str, model: str) -> str:
        """Generate cache key for a prompt."""
        content = f"{prompt}:{model}"
        return hashlib.md5(content.encode()).hexdigest()

    def _get_cached_response(self, cache_key: str) -> Optional[Any]:
        """Get cached response if available and not expired."""
        if not self.enable_cache:
            return None

        if cache_key in self.cache:
            cached = self.cache[cache_key]
            age = datetime.now() - cached.timestamp

            if age < self.cache_ttl:
                self.cache_hits += 1
                logger.info(f"Cache hit! Age: {age.total_seconds():.1f}s (Total hits: {self.cache_hits})")
                return cached.response
            else:
                # Expired, remove from cache
                del self.cache[cache_key]
                logger.info("Cache expired, fetching fresh response")

        return None

    def _cache_response(self, cache_key: str, response: Any, model: str):
        """Cache a response."""
        if self.enable_cache:
            self.cache[cache_key] = CachedResponse(
                response=response,
                timestamp=datetime.now(),
                model=model
            )
            logger.info(f"Cached response (total cached: {len(self.cache)})")

    def _select_model(self, complexity: float) -> str:
        """
        Select the appropriate model based on task complexity.

        Uses Haiku 4.5 for simple tasks (cheap, fast)
        Uses Sonnet 4.5 for complex tasks (expensive, more capable)

        Args:
            complexity: Float from 0.0 (simple) to 1.0 (complex)

        Returns:
            Model identifier string
        """
        if complexity >= self.complexity_threshold:
            model = self.advanced_model
            self.api_calls["sonnet"] += 1
            logger.info(f"Selected {model} for complex task (complexity: {complexity:.2f})")
        else:
            model = self.default_model
            self.api_calls["haiku"] += 1
            logger.info(f"Selected {model} for simple task (complexity: {complexity:.2f})")

        return model

    def get_cost_stats(self) -> Dict[str, Any]:
        """Get cost and usage statistics."""
        total_calls = self.api_calls["haiku"] + self.api_calls["sonnet"]

        # Approximate costs (per million tokens)
        # Average command: ~300 input, ~150 output
        haiku_cost_per_call = (300 * 0.25 / 1_000_000) + (150 * 1.25 / 1_000_000)  # ~$0.000263
        sonnet_cost_per_call = (300 * 3.0 / 1_000_000) + (150 * 15.0 / 1_000_000)  # ~$0.003150

        estimated_cost = (
            self.api_calls["haiku"] * haiku_cost_per_call +
            self.api_calls["sonnet"] * sonnet_cost_per_call
        )

        return {
            "total_api_calls": total_calls,
            "haiku_calls": self.api_calls["haiku"],
            "sonnet_calls": self.api_calls["sonnet"],
            "cache_hits": self.cache_hits,
            "cache_size": len(self.cache),
            "estimated_cost_usd": round(estimated_cost, 4),
            "haiku_percentage": round(self.api_calls["haiku"] / total_calls * 100, 1) if total_calls > 0 else 0
        }

    async def process_command(self, text: str, context: Optional[Dict] = None) -> Dict:
        """
        Process a natural language command from the user.

        This is the main entry point for JARVIS interactions.
        JARVIS interprets your intent and coordinates the appropriate response.

        Args:
            text: The user's command/question
            context: Optional additional context

        Returns:
            Dict with success, response text, and metadata
        """
        logger.info(f"JARVIS processing: '{text}'")

        # Add to conversation history
        conversation_entry = {
            "timestamp": datetime.now().isoformat(),
            "user": text,
            "context": context or {}
        }
        self.conversation_history.append(conversation_entry)

        try:
            # Step 1: Interpret intent
            intent = await self._interpret_intent(text)
            logger.info(f"Intent classified as: {intent.type} (confidence: {intent.confidence}, complexity: {intent.complexity:.2f})")

            # Step 2: Route to appropriate handler
            if intent.type == "information":
                response = await self._handle_information_request(text, intent)
            elif intent.type == "agent_task":
                response = await self._handle_agent_task(text, intent)
            elif intent.type == "knowledge_management":
                response = await self._handle_knowledge_management(text, intent)
            else:
                response = await self._handle_general(text, intent)

            # Store response in history
            conversation_entry["assistant"] = response
            conversation_entry["intent"] = intent.type
            conversation_entry["complexity"] = intent.complexity

            # Get cost stats
            cost_stats = self.get_cost_stats()

            return {
                "success": True,
                "response": response,
                "intent": intent.type,
                "confidence": intent.confidence,
                "complexity": intent.complexity,
                "cost_stats": cost_stats,
                "timestamp": datetime.now().isoformat()
            }

        except Exception as e:
            logger.error(f"Error processing command: {e}", exc_info=True)
            error_msg = self.personality.error() + f" {str(e)}"
            conversation_entry["error"] = str(e)

            return {
                "success": False,
                "response": error_msg,
                "error": str(e),
                "timestamp": datetime.now().isoformat()
            }

    async def _call_claude_api(self, prompt: str, complexity: float = 0.5, max_tokens: int = 500) -> Optional[str]:
        """
        Call Claude API with smart model selection and caching.

        Args:
            prompt: The prompt to send to Claude
            complexity: Task complexity (0.0-1.0)
            max_tokens: Maximum tokens in response

        Returns:
            Response text or None if error
        """
        if not self.anthropic_api_key:
            return None

        # Select model based on complexity
        model = self._select_model(complexity)

        # Check cache
        cache_key = self._get_cache_key(prompt, model)
        cached_response = self._get_cached_response(cache_key)
        if cached_response:
            return cached_response

        # Make API call
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": self.anthropic_api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json"
                    },
                    json={
                        "model": model,
                        "max_tokens": max_tokens,
                        "messages": [{
                            "role": "user",
                            "content": prompt
                        }]
                    }
                )

                if response.status_code == 200:
                    result = response.json()
                    content = result["content"][0]["text"]

                    # Cache the response
                    self._cache_response(cache_key, content, model)

                    return content
                else:
                    logger.warning(f"Claude API error: {response.status_code}")
                    return None

        except Exception as e:
            logger.error(f"Error calling Claude API: {e}")
            return None

    async def _interpret_intent(self, text: str) -> Intent:
        """
        Use Claude to interpret user intent.

        JARVIS uses Claude (Haiku for speed) to understand what you want:
        - Information retrieval ("What's the status...")
        - Agent task ("Design a system...")
        - Knowledge management ("Crawl the docs...")
        - General conversation
        """
        if not self.anthropic_api_key:
            # Fallback to simple keyword matching if no API key
            return self._simple_intent_classification(text)

        prompt = f"""Analyze this command and determine the intent:

Command: "{text}"

Context:
- User: {self.user_name}
- Recent conversation: {self.conversation_history[-3:] if self.conversation_history else "None"}

Classify the intent as one of:
1. information - User wants to know something (status, facts, etc.)
2. agent_task - User wants agents to analyze, design, or implement something
3. knowledge_management - User wants to manage knowledge base (crawl, upload, search)
4. general - Conversational, greeting, or unclear

Also determine task complexity (0.0-1.0):
- 0.0-0.3: Simple (greetings, status checks, basic queries)
- 0.4-0.7: Moderate (information requests, simple analysis)
- 0.8-1.0: Complex (multi-agent coordination, architecture decisions, technical analysis)

Also suggest which specialist agents (rings) would be helpful:
- nenya (Product Manager): requirements, user stories, stakeholder analysis
- vilya (System Architect): architecture, design, tech stack decisions
- narya (Research Analyst): research, competitive analysis, feasibility

Return ONLY valid JSON in this exact format:
{{
  "type": "...",
  "details": "brief explanation",
  "confidence": 0.85,
  "complexity": 0.5,
  "suggested_agents": ["agent_id"],
  "requires_knowledge": true/false
}}"""

        # Intent classification is always low complexity - use Haiku
        content = await self._call_claude_api(prompt, complexity=0.3, max_tokens=500)

        if content:
            try:
                # Extract JSON from response
                # Claude might wrap it in markdown code blocks
                if "```json" in content:
                    json_str = content.split("```json")[1].split("```")[0].strip()
                elif "```" in content:
                    json_str = content.split("```")[1].split("```")[0].strip()
                else:
                    json_str = content.strip()

                intent_data = json.loads(json_str)
                return Intent(**intent_data)
            except Exception as e:
                logger.error(f"Error parsing intent JSON: {e}")
                return self._simple_intent_classification(text)
        else:
            return self._simple_intent_classification(text)

    def _simple_intent_classification(self, text: str) -> Intent:
        """Fallback simple keyword-based intent classification."""
        text_lower = text.lower()

        # Check for agent task keywords
        agent_keywords = ["design", "create", "implement", "build", "develop", "analyze", "architect"]
        if any(keyword in text_lower for keyword in agent_keywords):
            suggested = []
            if any(word in text_lower for word in ["architecture", "design", "system"]):
                suggested.append("vilya")
            if any(word in text_lower for word in ["requirements", "user", "stakeholder"]):
                suggested.append("nenya")
            if any(word in text_lower for word in ["research", "analyze", "compare"]):
                suggested.append("narya")

            return Intent(
                type="agent_task",
                details="User wants specialist agent assistance",
                confidence=0.7,
                complexity=0.8,  # Agent tasks are complex
                suggested_agents=suggested or ["vilya"],
                requires_knowledge=True
            )

        # Check for knowledge management
        knowledge_keywords = ["crawl", "upload", "add", "knowledge", "docs", "documentation"]
        if any(keyword in text_lower for keyword in knowledge_keywords):
            return Intent(
                type="knowledge_management",
                details="User wants to manage knowledge base",
                confidence=0.8,
                complexity=0.3,  # Simple task
                suggested_agents=[],
                requires_knowledge=False
            )

        # Check for information requests
        info_keywords = ["what", "status", "show", "list", "tell me", "how many"]
        if any(keyword in text_lower for keyword in info_keywords):
            return Intent(
                type="information",
                details="User wants information",
                confidence=0.7,
                complexity=0.4,  # Moderate complexity
                suggested_agents=[],
                requires_knowledge=True
            )

        # Default to general
        return Intent(
            type="general",
            details="Conversational or unclear",
            confidence=0.5,
            complexity=0.2,  # Very simple
            suggested_agents=[],
            requires_knowledge=False
        )

    async def _handle_information_request(self, text: str, intent: Intent) -> str:
        """Handle information requests by querying knowledge base."""
        logger.info("Handling information request")

        try:
            # Query Archon knowledge base via MCP
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self.archon_mcp_url}/mcp/call_tool",
                    json={
                        "name": "archon:rag_search_knowledge_base",
                        "arguments": {
                            "query": text,
                            "match_count": 5,
                            "return_mode": "pages"
                        }
                    }
                )

                if response.status_code == 200:
                    result = response.json()

                    # Parse MCP response
                    if isinstance(result, dict) and "content" in result:
                        content = result["content"][0]["text"]
                        data = json.loads(content)

                        if data.get("success") and data.get("results"):
                            results = data["results"]
                            summary = f"I found {len(results)} relevant results in the knowledge base:\n\n"

                            for i, result in enumerate(results[:3], 1):
                                title = result.get("title", "Untitled")
                                preview = result.get("preview", "")[:150]
                                summary += f"{i}. {title}\n   {preview}...\n\n"

                            return self.personality.custom_message(
                                f"{summary}Shall I elaborate on any of these, {{user}}?"
                            )
                        else:
                            return self.personality.custom_message(
                                "I couldn't find relevant information in the knowledge base for that query, {user}. Perhaps we should add more documentation?"
                            )
                else:
                    return self.personality.error() + " Unable to query knowledge base."

        except Exception as e:
            logger.error(f"Error querying knowledge base: {e}")
            return self.personality.error() + f" {str(e)}"

    async def _handle_agent_task(self, text: str, intent: Intent) -> str:
        """
        Handle tasks that require specialist agent assistance.

        This is where JARVIS shines - coordinating multiple specialist
        Rings to solve complex problems.
        """
        logger.info(f"Handling agent task with suggested agents: {intent.suggested_agents}")

        # Step 1: Determine which rings to forge
        rings_to_forge = []
        for agent_id in intent.suggested_agents:
            if agent_id in self.rings:
                rings_to_forge.append(self.rings[agent_id])

        if not rings_to_forge:
            # Default to Vilya if no specific agents suggested
            rings_to_forge = [self.rings["vilya"]]

        # Step 2: Acknowledge and inform user
        ring_names = [ring.name for ring in rings_to_forge]
        ack_msg = self.personality.acknowledge()

        if len(rings_to_forge) == 1:
            forge_msg = self.personality.agent_forging(ring_names[0])
        else:
            forge_msg = self.personality.custom_message(
                f"I'll engage {', '.join(ring_names)} for this task, {{user}}."
            )

        # Step 3: Query knowledge base for context (if needed)
        knowledge_context = None
        if intent.requires_knowledge:
            try:
                knowledge_context = await self._query_knowledge_base(text)
            except Exception as e:
                logger.warning(f"Could not query knowledge base: {e}")

        # Step 4: For Phase 1, return a simulated response
        # In Phase 2, we'll actually forge the rings via agent work orders

        response_parts = [ack_msg, forge_msg]

        # Simulate ring analysis
        for ring in rings_to_forge:
            analysis = await self._simulate_ring_analysis(ring, text, knowledge_context)
            response_parts.append(f"\n\n**{ring.name} ({ring.role}) Analysis:**\n{analysis}")

        response_parts.append(
            f"\n\n{self.personality.complete()} Would you like me to proceed with implementation, {self.user_name}?"
        )

        return "\n".join(response_parts)

    async def _query_knowledge_base(self, query: str) -> Optional[Dict]:
        """Query Archon knowledge base for relevant context."""
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{self.archon_mcp_url}/mcp/call_tool",
                    json={
                        "name": "archon:rag_search_knowledge_base",
                        "arguments": {
                            "query": query,
                            "match_count": 3,
                            "return_mode": "pages"
                        }
                    }
                )

                if response.status_code == 200:
                    result = response.json()
                    if isinstance(result, dict) and "content" in result:
                        content = result["content"][0]["text"]
                        return json.loads(content)
        except Exception as e:
            logger.error(f"Error querying knowledge base: {e}")

        return None

    async def _simulate_ring_analysis(self, ring: Ring, task: str, knowledge: Optional[Dict]) -> str:
        """
        Simulate ring analysis for Phase 1.
        In Phase 2, this will actually spawn agents via work orders.
        """
        # For now, return a JARVIS-style acknowledgment that the agent would be consulted
        return f"Based on my analysis, I would recommend consulting with the {ring.role} specialist for detailed guidance on: {task}. This agent specializes in {', '.join(ring.capabilities)}."

    async def _handle_knowledge_management(self, text: str, intent: Intent) -> str:
        """Handle knowledge base management requests."""
        logger.info("Handling knowledge management request")

        # For Phase 1, provide guidance
        return self.personality.custom_message(
            "For knowledge base management, please use the Archon Dashboard at http://localhost:3737. You can crawl websites, upload documents, and manage sources there, {user}."
        )

    async def _handle_general(self, text: str, intent: Intent) -> str:
        """Handle general conversation."""
        text_lower = text.lower()

        # Greetings
        if any(greeting in text_lower for greeting in ["hello", "hi", "hey", "good morning", "good afternoon"]):
            return self.personality.greet()

        # Status check
        if any(word in text_lower for word in ["status", "how are you", "systems"]):
            cost_stats = self.get_cost_stats()
            return self.personality.custom_message(
                f"All systems operational, {{user}}. Ready to assist with your development work.\n\n"
                f"**System Stats:**\n"
                f"- API Calls: {cost_stats['total_api_calls']} ({cost_stats['haiku_percentage']}% Haiku)\n"
                f"- Cache Hits: {cost_stats['cache_hits']}\n"
                f"- Estimated Cost: ${cost_stats['estimated_cost_usd']:.4f}"
            )

        # Default
        return self.personality.custom_message(
            "I'm ready to assist, {user}. You can ask me to analyze systems, search the knowledge base, or coordinate specialist agents for complex tasks."
        )
