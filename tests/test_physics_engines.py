import builtins
from math import cos, sin, pi, sqrt

import pytest

from orbital_game.basilisk_engine import BasiliskPhysicsEngine, BasiliskUnavailable
from orbital_game.physics import NewtonianPhysicsEngine, make_engine


@pytest.fixture
def native():
    try:
        return BasiliskPhysicsEngine()
    except BasiliskUnavailable:
        pytest.skip("Optional Basilisk is not installed")


def norm(vector):
    return sqrt(sum(x*x for x in vector))


def without_basilisk(monkeypatch):
    original_import = builtins.__import__
    def no_native(name, *args, **kwargs):
        if name == "Basilisk" or name.startswith("Basilisk."):
            raise ModuleNotFoundError("Basilisk missing", name="Basilisk")
        return original_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", no_native)


def test_basilisk_initial_units_and_fractional_steps(native):
    initial = native.advance(0)
    assert initial.position == pytest.approx((4000, 0, 0))
    assert 600 < initial.altitude < 610
    assert 3.2 < initial.orbital_velocity < 3.3
    elapsed = 0
    for dt in (0.25, 0.55, 1.1, 0.123456789, 10):
        elapsed += dt
        state = native.advance(dt)
        angle = initial.orbital_velocity / 4000 * elapsed
        assert state.position == pytest.approx((4000*cos(angle), 4000*sin(angle), 0), abs=1e-7)
        assert state.velocity == pytest.approx((-initial.orbital_velocity*sin(angle), initial.orbital_velocity*cos(angle), 0), abs=1e-9)


def test_basilisk_full_orbit_conservation_and_reset(native):
    initial = native.advance(0)
    mu = initial.orbital_velocity**2 * 4000
    period = 2*pi*4000 / initial.orbital_velocity
    energies = []
    for _ in range(20):
        state = native.advance(period / 20)
        energies.append(norm(state.velocity)**2 / 2 - mu/norm(state.position))
        assert state.altitude == pytest.approx(initial.altitude, abs=1e-5)
    assert max(energies) - min(energies) < 1e-9
    assert state.position == pytest.approx(initial.position, abs=1e-5)
    native.reset()
    assert native.advance(0) == initial


def test_long_and_short_native_steps(native):
    long = native.advance(100)
    native.reset()
    for _ in range(100):
        short = native.advance(1)
    assert short == long


def test_native_instances_are_independent(native):
    other = BasiliskPhysicsEngine()
    first = native.advance(20)
    other.advance(100)
    assert native.advance(0) == first


@pytest.mark.parametrize("seconds", [-1, float("nan"), float("inf")])
def test_engines_reject_invalid_time(native, seconds):
    for engine in (native, NewtonianPhysicsEngine((4000, 0, 0), (0, 3.27, 0))):
        with pytest.raises(ValueError):
            engine.advance(seconds)


def test_native_impulse_and_custom_initial_state(native):
    initial = native.advance(0)
    changed = native.impulse((0, 0.3, 0))
    assert changed.position == initial.position
    assert changed.velocity[1] == pytest.approx(initial.velocity[1] + 0.3)
    future = native.advance(100)
    assert norm(future.position) > 4000
    clone = BasiliskPhysicsEngine(initial.position, changed.velocity)
    assert clone.advance(100).position == pytest.approx(future.position, abs=1e-8)
    native.reset()
    assert native.advance(0) == initial


def test_newtonian_fallback_agrees_with_basilisk(native):
    initial = native.advance(0)
    native.impulse((0, 0.3, 0))
    fallback = NewtonianPhysicsEngine(initial.position, initial.velocity)
    fallback.impulse((0, 0.3, 0))
    assert fallback.advance(1000).position == pytest.approx(native.advance(1000).position, abs=1e-4)


def test_auto_fallback_and_strict_backend(monkeypatch):
    without_basilisk(monkeypatch)
    assert isinstance(make_engine((4000, 0, 0), (0, 3.27, 0), "auto"), NewtonianPhysicsEngine)
    with pytest.raises(BasiliskUnavailable):
        make_engine((4000, 0, 0), (0, 3.27, 0), "basilisk")
    assert isinstance(make_engine((4000, 0, 0), (0, 3.27, 0), "newtonian"), NewtonianPhysicsEngine)


def test_broken_install_is_not_silently_hidden(monkeypatch):
    original_import = builtins.__import__
    def broken(name, *args, **kwargs):
        if name.startswith("Basilisk."):
            raise ModuleNotFoundError("dependency missing", name="some_dependency")
        return original_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", broken)
    with pytest.raises(ModuleNotFoundError, match="dependency missing"):
        make_engine((4000, 0, 0), (0, 3.27, 0), "auto")


def test_backend_selection(monkeypatch):
    monkeypatch.setenv("GAME_PHYSICS", "newtonian")
    assert isinstance(make_engine((4000, 0, 0), (0, 3.27, 0)), NewtonianPhysicsEngine)
    with pytest.raises(ValueError, match="GAME_PHYSICS"):
        make_engine((4000, 0, 0), (0, 3.27, 0), "typo")
