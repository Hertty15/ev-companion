"""Chat and WebSocket endpoints."""
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
from typing import List
from app.database import get_db, Message, EVData
from app.models import MessageCreate, MessageResponse, ChatHistoryResponse, EVStatus
from app.auth import get_current_user, get_current_user_ws
from app.ai_engine import ai_engine
import json
from datetime import datetime

router = APIRouter(prefix="/chat", tags=["Chat"])

# Active WebSocket connections
active_connections: dict = {}  # user_id -> list of WebSocket objects

@router.get("/history", response_model=ChatHistoryResponse)
async def get_chat_history(
    limit: int = 50,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get chat history for current user."""
    messages = db.query(Message).filter(
        Message.user_id == current_user.id
    ).order_by(Message.created_at.desc()).limit(limit).all()

    return {
        "messages": list(reversed(messages)),
        "total": len(messages)
    }

@router.get("/ev-status", response_model=EVStatus)
async def get_ev_status(
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get current EV status for user."""
    ev_data = db.query(EVData).filter(EVData.user_id == current_user.id).first()

    if not ev_data:
        # Create default EV data
        ev_data = EVData(user_id=current_user.id)
        db.add(ev_data)
        db.commit()
        db.refresh(ev_data)

    return {
        "battery_level": ev_data.battery_level,
        "range_km": ev_data.range_km,
        "charging": ev_data.charging,
        "charge_rate_kw": ev_data.charge_rate_kw,
        "estimated_full_charge": ev_data.estimated_full_charge,
        "odometer_km": ev_data.odometer_km,
        "last_updated": ev_data.last_updated
    }

@router.post("/ev-status")
async def update_ev_status(
    status: EVStatus,
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update EV status (from your laptop/desktop app)."""
    ev_data = db.query(EVData).filter(EVData.user_id == current_user.id).first()

    if not ev_data:
        ev_data = EVData(user_id=current_user.id)
        db.add(ev_data)

    ev_data.battery_level = status.battery_level
    ev_data.range_km = status.range_km
    ev_data.charging = status.charging
    ev_data.charge_rate_kw = status.charge_rate_kw
    ev_data.estimated_full_charge = status.estimated_full_charge
    ev_data.odometer_km = status.odometer_km
    ev_data.last_updated = datetime.utcnow()

    db.commit()

    # Broadcast update to all connected clients
    await broadcast_ev_update(current_user.id, {
        "type": "ev_update",
        "data": {
            "battery_level": ev_data.battery_level,
            "range_km": ev_data.range_km,
            "charging": ev_data.charging,
            "charge_rate_kw": ev_data.charge_rate_kw,
            "estimated_full_charge": ev_data.estimated_full_charge,
            "odometer_km": ev_data.odometer_km,
            "last_updated": ev_data.last_updated.isoformat()
        }
    })

    return {"status": "updated"}

@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, db: Session = Depends(get_db)):
    """WebSocket for real-time chat."""
    await websocket.accept()

    # Wait for auth message
    try:
        auth_msg = await websocket.receive_text()
        auth_data = json.loads(auth_msg)

        if auth_data.get("type") != "auth":
            await websocket.close(code=4001, reason="Auth required first")
            return

        token = auth_data.get("token")
        user = await get_current_user_ws(token, db)

        # Register connection
        if user.id not in active_connections:
            active_connections[user.id] = []
        active_connections[user.id].append(websocket)

        # Send confirmation
        await websocket.send_json({
            "type": "connected",
            "user_id": user.id,
            "username": user.username
        })

        # Message loop
        while True:
            data = await websocket.receive_text()
            msg_data = json.loads(data)

            if msg_data.get("type") == "chat":
                content = msg_data.get("content", "").strip()
                if not content:
                    continue

                # Save user message
                user_msg = Message(
                    user_id=user.id,
                    content=content,
                    role="user"
                )
                db.add(user_msg)
                db.commit()

                # Broadcast to all user's connections
                await broadcast_message(user.id, {
                    "type": "message",
                    "data": {
                        "id": user_msg.id,
                        "content": user_msg.content,
                        "role": "user",
                        "created_at": user_msg.created_at.isoformat()
                    }
                })

                # Get EV context
                ev_data = db.query(EVData).filter(EVData.user_id == user.id).first()
                ev_context = None
                if ev_data:
                    ev_context = {
                        "battery_level": ev_data.battery_level,
                        "range_km": ev_data.range_km,
                        "charging": ev_data.charging,
                        "odometer_km": ev_data.odometer_km
                    }

                # Get recent chat history for context
                recent_msgs = db.query(Message).filter(
                    Message.user_id == user.id
                ).order_by(Message.created_at.desc()).limit(10).all()

                chat_history = [
                    {"role": msg.role, "content": msg.content}
                    for msg in reversed(recent_msgs)
                ]

                # Get AI response
                ai_response = await ai_engine.chat(chat_history, ev_context)

                # Save AI message
                ai_msg = Message(
                    user_id=user.id,
                    content=ai_response,
                    role="assistant"
                )
                db.add(ai_msg)
                db.commit()

                # Broadcast AI response
                await broadcast_message(user.id, {
                    "type": "message",
                    "data": {
                        "id": ai_msg.id,
                        "content": ai_msg.content,
                        "role": "assistant",
                        "created_at": ai_msg.created_at.isoformat()
                    }
                })

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        # Cleanup
        if user.id in active_connections:
            if websocket in active_connections[user.id]:
                active_connections[user.id].remove(websocket)
            if not active_connections[user.id]:
                del active_connections[user.id]

async def broadcast_message(user_id: int, message: dict):
    """Send message to all connections for a user."""
    if user_id in active_connections:
        disconnected = []
        for conn in active_connections[user_id]:
            try:
                await conn.send_json(message)
            except:
                disconnected.append(conn)

        # Remove dead connections
        for conn in disconnected:
            active_connections[user_id].remove(conn)

async def broadcast_ev_update(user_id: int, update: dict):
    """Broadcast EV status update."""
    await broadcast_message(user_id, update)
