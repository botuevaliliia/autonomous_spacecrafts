"""Game physics selection and an honest inverse-square fallback, in km and s."""
import os
from dataclasses import dataclass
from math import isfinite, sqrt

MU = 42828.314  # Mars gravitational parameter, km^3/s^2 (Basilisk Mars body).
RADIUS = 3396.19


@dataclass(frozen=True)
class PhysicsState:
    position: tuple[float, float, float]
    velocity: tuple[float, float, float]
    central_body_radius_km: float = RADIUS

    @property
    def altitude(self) -> float:
        """Height above the reference sphere in km."""
        return sqrt(sum(value * value for value in self.position)) - self.central_body_radius_km

    @property
    def orbital_velocity(self) -> float:
        """Scalar inertial speed in km/s."""
        return sqrt(sum(value * value for value in self.velocity))


class NewtonianPhysicsEngine:
    name = "newtonian"

    def __init__(self, position_km, velocity_km_s):
        self.initial = tuple(position_km) + tuple(velocity_km_s)
        self.reset()

    def reset(self):
        self.vector = self.initial

    @staticmethod
    def derivative(y):
        r3 = sum(v*v for v in y[:3]) ** 1.5
        return y[3:] + tuple(-MU*v/r3 for v in y[:3])

    def advance(self, seconds):
        if not isfinite(seconds) or seconds < 0:
            raise ValueError("Time must be finite and nonnegative")
        while seconds > 0:
            dt = min(1, seconds)
            y = self.vector
            k1 = self.derivative(y)
            k2 = self.derivative(tuple(a + dt*b/2 for a,b in zip(y,k1)))
            k3 = self.derivative(tuple(a + dt*b/2 for a,b in zip(y,k2)))
            k4 = self.derivative(tuple(a + dt*b for a,b in zip(y,k3)))
            self.vector = tuple(a + dt*(b+2*c+2*d+e)/6 for a,b,c,d,e in zip(y,k1,k2,k3,k4))
            seconds -= dt
        return PhysicsState(self.vector[:3], self.vector[3:], RADIUS)

    def impulse(self, dv):
        if len(dv) != 3 or not all(isfinite(v) for v in dv):
            raise ValueError("Burn must contain three finite components")
        self.vector = self.vector[:3] + tuple(a+b for a,b in zip(self.vector[3:], dv))
        return self.advance(0)


def make_engine(position, velocity, backend=None):
    backend = backend or os.getenv("GAME_PHYSICS", "auto")
    if backend not in ("auto", "basilisk", "newtonian"):
        raise ValueError("GAME_PHYSICS must be auto, basilisk, or newtonian")
    if backend != "newtonian":
        from orbital_game.basilisk_engine import BasiliskPhysicsEngine, BasiliskUnavailable
        try:
            return BasiliskPhysicsEngine(position, velocity)
        except BasiliskUnavailable:
            if backend == "basilisk":
                raise
    return NewtonianPhysicsEngine(position, velocity)
