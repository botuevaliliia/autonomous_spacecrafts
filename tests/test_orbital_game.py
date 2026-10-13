from math import atan2, pi, sqrt
from random import Random
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from orbital_game.api import create_app, create_game_router
from orbital_game.game import RendezvousGame, norm, circular
from orbital_game.physics import MU, RADIUS, make_engine
from orbital_game.basilisk_engine import BasiliskUnavailable


@pytest.fixture(params=["newtonian", "basilisk"])
def game(request):
    try:
        return RendezvousGame(request.param, rng=Random(42))
    except BasiliskUnavailable:
        pytest.skip("Optional Basilisk not installed")


def test_physical_circular_orbit_and_conservation(game):
    initial = game.ship.advance(0)
    period = 2*pi*sqrt(4000**3/MU)
    energy0 = norm(initial.velocity)**2/2-MU/norm(initial.position)
    momentum0 = initial.position[0]*initial.velocity[1]-initial.position[1]*initial.velocity[0]
    final = game.ship.advance(period)
    assert final.position == pytest.approx(initial.position, abs=1e-4)
    assert norm(final.velocity)**2/2-MU/norm(final.position) == pytest.approx(energy0, abs=1e-9)
    assert final.position[0]*final.velocity[1]-final.position[1]*final.velocity[0] == pytest.approx(momentum0, abs=1e-6)


def test_two_burn_transfer_reaches_station(game):
    r1,r2 = game.inner_radius,game.outer_radius
    first = sqrt(MU/r1)*(sqrt(2*r2/(r1+r2))-1)*1000
    second = sqrt(MU/r2)*(1-sqrt(2*r1/(r1+r2)))*1000
    before = game.get_state()
    wait = departure_wait(game)
    game.step(wait)
    departure_position = game.get_state()["ship"]["position"]
    game.burn(first, 0)
    assert game.get_state()["ship"]["position"] == departure_position
    game.step(game.transfer_time)
    encounter = game.get_state()
    assert encounter["distance_km"] < 0.01
    assert encounter["status"] == "FLYING"  # a fast flyby is not rendezvous
    assert encounter["relative_speed_m_s"] > game.capture_speed
    success = game.burn(second, 0)
    assert success["status"] == "ARRIVED"
    assert success["relative_speed_m_s"] < 0.01
    assert game.step(100) == success
    reset = game.reset()
    assert reset["ship"] == before["ship"]
    assert reset["target"]["position"] != before["target"]["position"]
    assert reset["time"] == 0 and reset["remaining_dv"] == 800


def departure_wait(game):
    state = game.get_state()
    ship, target = state["ship"]["position"], state["target"]["position"]
    phase = (atan2(target[1], target[0])-atan2(ship[1], ship[0])) % (2*pi)
    n1, n2 = sqrt(MU/game.inner_radius**3), sqrt(MU/game.outer_radius**3)
    desired = pi-n2*game.transfer_time
    return ((phase-desired) % (2*pi))/(n1-n2)


def test_random_starts_are_physical_distinct_and_solvable():
    game = RendezvousGame("newtonian", rng=Random(11))
    positions = set()
    for _ in range(100):
        state = game.reset()
        positions.add(tuple(state["target"]["position"]))
        assert norm(state["target"]["position"]) == pytest.approx(game.outer_radius)
        assert norm(state["target"]["velocity"]) == pytest.approx(sqrt(MU/game.outer_radius))
        assert 59.999 < departure_wait(game) < game.time_limit-game.transfer_time-599.999
    assert len(positions) == 100


@pytest.mark.parametrize("edge", [0, 1])
def test_earliest_and_latest_random_windows_allow_rendezvous(edge):
    class EdgeRandom:
        def uniform(self, low, high):
            return (low, high)[edge]

    game = RendezvousGame("newtonian", rng=EdgeRandom())
    r1, r2 = game.inner_radius, game.outer_radius
    game.step(departure_wait(game))
    game.burn(sqrt(MU/r1)*(sqrt(2*r2/(r1+r2))-1)*1000, 0)
    game.step(game.transfer_time)
    result = game.burn(sqrt(MU/r2)*(1-sqrt(2*r1/(r1+r2)))*1000, 0)
    assert result["status"] == "ARRIVED"
    assert result["time"] <= game.time_limit-599.99


def test_elliptical_coast_matches_kepler_and_vis_viva(game):
    """Check the whole ellipse against analytic mechanics, not another integrator."""
    r1, r2 = game.inner_radius, game.outer_radius
    semimajor = (r1+r2)/2
    departure_speed = sqrt(MU*(2/r1-1/semimajor))
    game.burn((departure_speed-sqrt(MU/r1))*1000, 0)
    expected_energy = -MU/(2*semimajor)
    expected_momentum = r1*departure_speed
    # Half-period T/2 = pi sqrt(a^3/mu); angular momentum implies equal areas.
    for sample in range(40):
        current = game.ship.advance(game.transfer_time/40)
        r, v = current.position, current.velocity
        assert norm(v)**2/2-MU/norm(r) == pytest.approx(expected_energy, abs=1e-9)
        assert r[0]*v[1]-r[1]*v[0] == pytest.approx(expected_momentum, abs=1e-6)
    assert norm(current.position) == pytest.approx(r2, abs=1e-4)
    assert norm(current.velocity) == pytest.approx(departure_speed*r1/r2, abs=1e-8)


def test_prediction_does_not_change_live_state_and_matches(game):
    before = game.get_state()
    prediction = game.preview(300, 0)
    assert game.get_state() == before
    game.burn(300, 0)
    game.step(60)
    assert game.get_state()["ship"]["position"][:2] == pytest.approx(prediction["points"][2], abs=1e-7)


def test_budget_rejection_and_impact(game):
    game.burn(450, 180)
    unchanged = game.get_state()
    with pytest.raises(ValueError, match="remaining"):
        game.burn(400, 0)
    assert game.get_state() == unchanged
    result = game.step(10000)
    assert result["status"] == "IMPACT"
    assert result["ship"]["altitude"] <= 0
    with pytest.raises(ValueError, match="ended"):
        game.burn(1, 0)


def test_timeout():
    game = RendezvousGame("newtonian")
    assert game.step(18001)["status"] == "TIMEOUT"
    assert game.time == 18000


def test_game_api_validation_and_separate_reset():
    app = FastAPI()
    app.include_router(create_game_router("newtonian"))
    with TestClient(app) as client:
        initial = client.get("/game/state").json()
        assert initial["physics_engine"] == "newtonian"
        for body in [{"seconds": 0}, {"seconds": 601}, {"seconds": "NaN"}]:
            assert client.post("/game/step", json=body).status_code == 422
        assert client.post("/game/burn", json={"magnitude_m_s": 451, "angle_deg": 0}).status_code == 422
        assert client.post("/game/burn", json={"magnitude_m_s": 0, "angle_deg": 0}).status_code == 409
        assert client.post("/game/burn", json={"magnitude_m_s": 300, "angle_deg": 0}).json()["remaining_dv"] == 500
        assert client.post("/game/step", json={"seconds": 30}).json()["time"] == 30
        reset = client.post("/game/reset").json()
        assert reset["time"] == 0 and reset["remaining_dv"] == 800
        assert reset["ship"] == initial["ship"]
        assert reset["target"]["position"] != initial["target"]["position"]


def test_app_serves_game_page_and_api():
    with TestClient(create_app("newtonian")) as client:
        assert client.get("/", follow_redirects=False).headers["location"] == "/play/"
        page = client.get("/play/")
        assert page.status_code == 200 and "game.js" in page.text
        assert client.get("/play/game.js").status_code == 200
        assert client.get("/game/state").json()["physics_engine"] == "newtonian"
