"""One shared in-memory game per API process. Run with one worker."""
from pathlib import Path
from threading import RLock
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from orbital_game.game import RendezvousGame


class GameInput(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class BurnInput(GameInput):
    magnitude_m_s: float = Field(ge=0, le=450)
    angle_deg: float = Field(ge=-180, le=180)


class StepInput(GameInput):
    seconds: float = Field(gt=0, le=600)


def create_game_router(backend=None):
    router = APIRouter(prefix="/game", tags=["Orbital game"])
    lock = RLock()
    game = None

    def current():
        nonlocal game
        if game is None:
            game = RendezvousGame(backend)
        return game

    @router.get("/state")
    def state():
        with lock:
            return current().get_state()

    @router.post("/reset")
    def reset():
        with lock:
            return current().reset()

    @router.post("/step")
    def step(request: StepInput):
        with lock:
            return current().step(request.seconds)

    @router.post("/burn")
    def burn(request: BurnInput):
        with lock:
            try:
                return current().burn(request.magnitude_m_s, request.angle_deg)
            except ValueError as exc:
                raise HTTPException(409, str(exc)) from exc

    @router.post("/preview")
    def preview(request: BurnInput):
        with lock:
            try:
                return current().preview(request.magnitude_m_s, request.angle_deg)
            except ValueError as exc:
                raise HTTPException(409, str(exc)) from exc

    return router


def create_app(backend=None):
    app = FastAPI(title="Meet Me in Orbit", version="0.1.0")
    app.include_router(create_game_router(backend))
    app.get("/", include_in_schema=False)(lambda: RedirectResponse("/play/"))
    app.mount("/play", StaticFiles(directory=Path(__file__).resolve().parent / "static", html=True), name="game")
    return app


app = create_app()
