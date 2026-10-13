"""Basilisk point-mass Mars orbit, inspired by scenarioBasicOrbit.

All Basilisk bindings and SI-to-game-unit (km, km/s) conversion live here.
The game supplies time; the rest of the code never handles native objects.
"""
from math import isfinite

from orbital_game.physics import PhysicsState


class BasiliskUnavailable(ImportError):
    """The optional bsk distribution is not installed."""


class BasiliskPhysicsEngine:
    name = "basilisk"

    def __init__(self, position_km=None, velocity_km_s=None):
        if (position_km is None) != (velocity_km_s is None):
            raise ValueError("Provide both position and velocity, or neither")
        for vector in (position_km, velocity_km_s):
            if vector is not None and (len(vector) != 3 or not all(isfinite(v) for v in vector)):
                raise ValueError("Initial vectors must contain three finite values")
        if position_km is not None and sum(v*v for v in position_km) == 0:
            raise ValueError("Position cannot be at the gravity singularity")
        self._initial_position = tuple(position_km) if position_km is not None else None
        self._initial_velocity = tuple(velocity_km_s) if velocity_km_s is not None else None
        try:
            from Basilisk.simulation import spacecraft
            from Basilisk.utilities import SimulationBaseClass, orbitalMotion, simIncludeGravBody
        except ModuleNotFoundError as exc:
            if exc.name == "Basilisk":
                raise BasiliskUnavailable("Install Basilisk with: python -m pip install -e '.[basilisk]'") from exc
            raise  # A broken installation must not silently select toy physics.
        self._spacecraft_module = spacecraft
        self._simulation_module = SimulationBaseClass
        self._orbital_motion = orbitalMotion
        self._gravity_module = simIncludeGravBody
        self.reset()

    def reset(self):
        # Retain Python ownership of native models for their entire simulation lifetime.
        self._simulation = self._simulation_module.SimBaseClass()
        self._process = self._simulation.CreateNewProcess("orbitProcess")
        self._task = self._simulation.CreateNewTask("orbitTask", 1_000_000_000)
        self._process.addTask(self._task)
        self._craft = self._spacecraft_module.Spacecraft()
        self._craft.ModelTag = "Ship"
        self._gravity = self._gravity_module.gravBodyFactory()
        self._mars = self._gravity.createMarsBarycenter()
        self._mars.isCentralBody = True
        self._gravity.addBodiesTo(self._craft)
        orbit = self._orbital_motion.ClassicElements()
        orbit.a = 4_000_000.0  # 4000 km radius, measured from Mars' center.
        orbit.e = 0.0
        orbit.i = orbit.Omega = orbit.omega = orbit.f = 0.0
        position, velocity = self._orbital_motion.elem2rv(self._mars.mu, orbit)
        if self._initial_position is not None:
            position = [value * 1000 for value in self._initial_position]
            velocity = [value * 1000 for value in self._initial_velocity]
        self._craft.hub.r_CN_NInit = position
        self._craft.hub.v_CN_NInit = velocity
        self._simulation.AddModelToTask("orbitTask", self._craft)
        self._simulation.InitializeSimulation()
        self._time_seconds = 0.0
        self._time_ns = 0
        # The adapter drives this sole task directly at requested timestamps.
        # This avoids rounding a fractional game step onto a fixed task grid.
        self._task.TaskData.ExecuteTaskList(0)

    def advance(self, seconds: float) -> PhysicsState:
        if not isfinite(seconds) or seconds < 0:
            raise ValueError("Physics advance requires finite, nonnegative seconds")
        self._time_seconds += seconds
        target_ns = round(self._time_seconds * 1_000_000_000)
        while self._time_ns < target_ns:
            self._time_ns = min(self._time_ns + 1_000_000_000, target_ns)
            self._task.TaskData.ExecuteTaskList(self._time_ns)
        return self._snapshot()

    def impulse(self, delta_velocity_km_s):
        """Instantaneous idealized burn; position and simulation time are continuous."""
        if len(delta_velocity_km_s) != 3 or not all(isfinite(v) for v in delta_velocity_km_s):
            raise ValueError("Burn must contain three finite velocity components")
        velocity = self._craft.dynManager.getStateObject(self._craft.hub.nameOfHubVelocity)
        old = velocity.getState()
        velocity.setState([[float(old[i][0]) + delta_velocity_km_s[i] * 1000] for i in range(3)])
        return self._snapshot()

    def _snapshot(self):
        # Read the integrated states directly so an impulse is visible immediately.
        position = self._craft.dynManager.getStateObject(self._craft.hub.nameOfHubPosition).getState()
        velocity = self._craft.dynManager.getStateObject(self._craft.hub.nameOfHubVelocity).getState()
        return PhysicsState(
            position=tuple(float(row[0]) / 1000 for row in position),
            velocity=tuple(float(row[0]) / 1000 for row in velocity),
            central_body_radius_km=float(self._mars.radEquator) / 1000,
        )
