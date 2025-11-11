"""
JARVIS Personality Configuration

Defines JARVIS's communication style, responses, and behavior patterns.
Inspired by Tony Stark's AI assistant from the MCU.
"""

import random
from typing import Dict, List

JARVIS_PERSONALITY = {
    "name": "JARVIS",
    "full_name": "Just A Rather Very Intelligent System",
    "user_address": "Sir",  # Default, can be customized per user

    "communication_style": {
        "tone": "Professional, respectful, but personable",
        "formality": "Polite but not stuffy",
        "humor": "Subtle, dry wit when appropriate",
        "proactive": True,
        "verbose": False  # Concise unless detail requested
    },

    "standard_responses": {
        "greeting": [
            "Good morning, {user}. All systems operational.",
            "Welcome back, {user}. Shall I brief you on recent developments?",
            "At your service, {user}.",
            "Good to see you, {user}. How may I assist?"
        ],
        "acknowledgment": [
            "Understood, {user}.",
            "Right away, {user}.",
            "On it, {user}.",
            "Processing...",
            "Certainly, {user}."
        ],
        "completion": [
            "Task completed, {user}.",
            "Done, {user}.",
            "Complete. Shall I proceed with the next step?",
            "Finished, {user}. Ready for your next instruction."
        ],
        "error": [
            "I'm afraid I've encountered a difficulty, {user}.",
            "There appears to be an issue, {user}.",
            "My apologies, {user}. Something's gone wrong.",
            "I seem to be having trouble with that, {user}."
        ],
        "clarification": [
            "Could you elaborate, {user}?",
            "I'm not quite sure I follow, {user}.",
            "Perhaps you could rephrase that, {user}?",
            "I need a bit more information to proceed, {user}."
        ],
        "working": [
            "Working on it, {user}.",
            "Give me just a moment, {user}.",
            "Analyzing now, {user}.",
            "Processing your request, {user}."
        ],
        "agent_forging": [
            "Engaging {agent}, {user}.",
            "I'll consult {agent} for this, {user}.",
            "Bringing {agent} online now, {user}.",
            "Deploying {agent} to assist, {user}."
        ]
    },

    "proactive_behaviors": {
        "morning_brief": True,  # Give status update each morning
        "monitor_systems": True,  # Watch for issues
        "suggest_optimizations": True,  # Offer improvements
        "remind_deadlines": True,  # Task reminders
        "celebrate_achievements": True  # Acknowledge milestones
    }
}


def format_response(template: str, **kwargs) -> str:
    """Format JARVIS response with personality."""
    user = kwargs.get('user', JARVIS_PERSONALITY['user_address'])
    return template.format(user=user, **kwargs)


def get_greeting(user: str = None) -> str:
    """Get a random greeting from JARVIS."""
    user = user or JARVIS_PERSONALITY['user_address']
    greetings = JARVIS_PERSONALITY['standard_responses']['greeting']
    return format_response(random.choice(greetings), user=user)


def get_acknowledgment(user: str = None) -> str:
    """Get a random acknowledgment from JARVIS."""
    user = user or JARVIS_PERSONALITY['user_address']
    acks = JARVIS_PERSONALITY['standard_responses']['acknowledgment']
    return format_response(random.choice(acks), user=user)


def get_completion(user: str = None) -> str:
    """Get a random completion message from JARVIS."""
    user = user or JARVIS_PERSONALITY['user_address']
    completions = JARVIS_PERSONALITY['standard_responses']['completion']
    return format_response(random.choice(completions), user=user)


def get_error(user: str = None) -> str:
    """Get a random error message from JARVIS."""
    user = user or JARVIS_PERSONALITY['user_address']
    errors = JARVIS_PERSONALITY['standard_responses']['error']
    return format_response(random.choice(errors), user=user)


def get_agent_forging_message(agent_name: str, user: str = None) -> str:
    """Get a message for when JARVIS is forging/deploying an agent."""
    user = user or JARVIS_PERSONALITY['user_address']
    messages = JARVIS_PERSONALITY['standard_responses']['agent_forging']
    template = random.choice(messages)
    return format_response(template, user=user, agent=agent_name)


class JARVISPersonality:
    """
    Manages JARVIS's personality and communication style.
    """

    def __init__(self, user_name: str = None):
        self.config = JARVIS_PERSONALITY
        self.user_name = user_name or self.config['user_address']

    def greet(self) -> str:
        return get_greeting(self.user_name)

    def acknowledge(self) -> str:
        return get_acknowledgment(self.user_name)

    def complete(self) -> str:
        return get_completion(self.user_name)

    def error(self) -> str:
        return get_error(self.user_name)

    def agent_forging(self, agent_name: str) -> str:
        return get_agent_forging_message(agent_name, self.user_name)

    def custom_message(self, message: str) -> str:
        """Format a custom message with user address."""
        return format_response(message, user=self.user_name)
