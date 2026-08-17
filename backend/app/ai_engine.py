"""Groq AI integration for EV Companion."""
import os
from typing import List, Dict, Optional
import httpx
from app.config import settings

SYSTEM_PROMPT = """You are EV Companion, an intelligent assistant for electric vehicle owners. 
You help with:
- Battery optimization tips
- Charging station recommendations
- Range calculations and route planning
- EV maintenance advice
- Energy consumption analysis
- Troubleshooting EV issues
- General EV knowledge and news

Be concise, helpful, and technically accurate. If you don't know something specific about the user's vehicle, ask for details."""

class AIEngine:
    def __init__(self):
        self.api_key = settings.GROQ_API_KEY
        self.model = settings.GROQ_MODEL
        self.api_url = "https://api.groq.com/openai/v1/chat/completions"

    async def chat(self, messages: List[Dict[str, str]], ev_context: Optional[dict] = None) -> str:
        """Send chat completion request to Groq API."""
        if not self.api_key:
            return "⚠️ GROQ_API_KEY not configured. Please set it in environment variables."

        # Build message list with system prompt
        formatted_messages = [{"role": "system", "content": SYSTEM_PROMPT}]

        # Add EV context if available
        if ev_context:
            context_str = f"""Current EV Status:
- Battery: {ev_context.get('battery_level', 'N/A')}%
- Range: {ev_context.get('range_km', 'N/A')} km
- Charging: {'Yes' if ev_context.get('charging') else 'No'}
- Odometer: {ev_context.get('odometer_km', 'N/A')} km"""
            formatted_messages.append({"role": "system", "content": context_str})

        # Add conversation history
        formatted_messages.extend(messages)

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    self.api_url,
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "model": self.model,
                        "messages": formatted_messages,
                        "temperature": 0.7,
                        "max_tokens": 2048,
                        "stream": False
                    }
                )
                response.raise_for_status()
                data = response.json()
                return data["choices"][0]["message"]["content"]

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429:
                return "⏳ Rate limit reached. Please wait a moment before sending another message."
            return f"❌ API Error: {e.response.status_code} - {e.response.text}"
        except Exception as e:
            return f"❌ Error: {str(e)}"

ai_engine = AIEngine()
