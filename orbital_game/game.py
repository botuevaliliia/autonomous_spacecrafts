"""One self-contained level. No modifications to the original resource mission."""
from collections import deque
from math import atan2, cos, sin, sqrt, pi, radians
from random import Random

from orbital_game.physics import MU, RADIUS, make_engine


def norm(vector):
    return sqrt(sum(v*v for v in vector))


def circular(radius, angle):
    speed = sqrt(MU/radius)
    return (radius*cos(angle), radius*sin(angle), 0), (-speed*sin(angle), speed*cos(angle), 0)


def burn_vector(state, magnitude_m_s, angle_deg):
    # 0 = local transverse/prograde; +90 = radial outward.
    theta = atan2(state.position[1], state.position[0])
    angle = radians(angle_deg)
    dv = magnitude_m_s / 1000
    return (dv*(-sin(theta)*cos(angle) + cos(theta)*sin(angle)),
            dv*(cos(theta)*cos(angle) + sin(theta)*sin(angle)), 0)


class RendezvousGame:
    inner_radius = 4000.0
    outer_radius = 6000.0
    time_limit = 18000.0
    capture_distance = 20.0
    capture_speed = 30.0  # m/s; an educational rendezvous envelope, not docking.

    def __init__(self, backend=None, rng=None):
        self.backend = backend
        self.rng = rng if rng is not None else Random()
        self.reset()

    def reset(self):
        self.time = 0.0
        self.status = "FLYING"
        self.remaining_dv = 800.0
        self.burns = []
        self.message = "Aster starts somewhere new each attempt. Find your meeting window, then match its motion."
        self.transfer_time = pi*sqrt(((self.inner_radius+self.outer_radius)/2)**3/MU)
        self.start_angle = radians(-32)
        ship_rate = sqrt(MU/self.inner_radius**3)
        station_rate = sqrt(MU/self.outer_radius**3)
        # Randomize the orbital phase through a feasible departure window. Every
        # draw admits a two-burn transfer within five hours, with ten minutes spare.
        # The ship starts unchanged; waiting for alignment now matters.
        departure_wait = self.rng.uniform(60, self.time_limit-self.transfer_time-600)
        self.target_angle = (self.start_angle + pi - station_rate*self.transfer_time
                             + (ship_rate-station_rate)*departure_wait) % (2*pi)
        self.ship = make_engine(*circular(self.inner_radius, self.start_angle), self.backend)
        self.target = make_engine(*circular(self.outer_radius, self.target_angle), self.ship.name)
        self.trail = deque(maxlen=1400)
        self.last_trail_time = -100
        self.closest_distance = float("inf")
        self._assess()
        return self.get_state()

    def _assess(self):
        ship, target = self.ship.advance(0), self.target.advance(0)
        self.distance = norm(tuple(a-b for a,b in zip(ship.position, target.position)))
        self.relative_speed = norm(tuple(a-b for a,b in zip(ship.velocity, target.velocity)))*1000
        self.closest_distance = min(self.closest_distance, self.distance)
        if self.time - self.last_trail_time >= 10:
            self.trail.append(list(ship.position[:2]))
            self.last_trail_time = self.time
        if norm(ship.position) <= RADIUS:
            self.status, self.message = "IMPACT", "Your path met Mars. Rewind and give the planet a little more room."
        elif self.distance <= self.capture_distance and self.relative_speed <= self.capture_speed:
            self.status, self.message = "ARRIVED", "You made it. Same place, same pace. Lyra is opening the airlock."
        elif self.time >= self.time_limit:
            self.status, self.message = "TIMEOUT", "The rendezvous window closed. Every attempt teaches you an orbit."

    def step(self, seconds):
        end = min(self.time + seconds, self.time_limit)
        while self.time < end and self.status == "FLYING":
            dt = min(1, end-self.time)
            self.ship.advance(dt)
            self.target.advance(dt)
            self.time += dt
            self._assess()
        return self.get_state()

    def burn(self, magnitude_m_s, angle_deg):
        if self.status != "FLYING":
            raise ValueError("This flight has ended. Start a new attempt.")
        if magnitude_m_s <= 0 or magnitude_m_s > 450:
            raise ValueError("Choose a burn greater than 0 and at most 450 m/s.")
        if magnitude_m_s > self.remaining_dv + 1e-9:
            raise ValueError("That burn exceeds your remaining delta-v.")
        state = self.ship.advance(0)
        self.ship.impulse(burn_vector(state, magnitude_m_s, angle_deg))
        self.remaining_dv = max(0, self.remaining_dv-magnitude_m_s)
        self.burns.append({"time": self.time, "magnitude_m_s": magnitude_m_s, "angle_deg": angle_deg})
        self.message = "Burn complete. Your velocity changed; gravity will shape the path from here."
        self._assess()
        return self.get_state()

    def get_state(self):
        def body(engine):
            s = engine.advance(0)
            return {"position": s.position, "velocity": s.velocity,
                    "altitude": s.altitude, "speed": s.orbital_velocity}
        return {"time": self.time, "status": self.status, "message": self.message,
                "ship": body(self.ship), "target": body(self.target),
                "remaining_dv": self.remaining_dv, "burns": list(self.burns),
                "distance_km": self.distance, "relative_speed_m_s": self.relative_speed,
                "closest_distance_km": self.closest_distance, "trail": list(self.trail),
                "physics_engine": self.ship.name, "planet_radius_km": RADIUS,
                "inner_radius_km": self.inner_radius, "outer_radius_km": self.outer_radius,
                "time_limit": self.time_limit, "capture_distance_km": self.capture_distance,
                "capture_speed_m_s": self.capture_speed}

    def preview(self, magnitude_m_s, angle_deg):
        if magnitude_m_s > self.remaining_dv + 1e-9:
            raise ValueError("Preview burn exceeds remaining delta-v.")
        state = self.ship.advance(0)
        target = self.target.advance(0)
        engine = make_engine(state.position, state.velocity, self.ship.name)
        engine.impulse(burn_vector(state, magnitude_m_s, angle_deg))
        # Exact circular two-body station ephemeris, using its current angular phase.
        phase = atan2(target.position[1], target.position[0])
        rate = sqrt(MU/self.outer_radius**3)
        points = []
        closest = {"distance_km": float("inf"), "in_seconds": 0, "relative_speed_m_s": 0}
        impact = False
        horizon = min(10800, self.time_limit-self.time)
        for elapsed in range(int(horizon)+1):
            s = engine.advance(0 if elapsed == 0 else 1)
            tp, tv = circular(self.outer_radius, phase+rate*elapsed)
            distance = norm(tuple(a-b for a,b in zip(s.position, tp)))
            if distance < closest["distance_km"]:
                closest = {"distance_km": distance, "in_seconds": elapsed,
                           "relative_speed_m_s": norm(tuple(a-b for a,b in zip(s.velocity,tv)))*1000}
            if elapsed % 30 == 0:
                points.append(list(s.position[:2]))
            if norm(s.position) <= RADIUS:
                impact = True
                break
        return {"points": points, "closest": closest, "impact": impact, "from_time": self.time,
                "magnitude_m_s": magnitude_m_s, "angle_deg": angle_deg}
