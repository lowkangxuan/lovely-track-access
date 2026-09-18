"""
The one seam the team swaps.

`solve_scenario(scenario_name, input_data)` is the only entry point main.py
knows about. To plug in your own algorithm, write a module exposing

    def solve(scenario: str, data: InstanceData) -> SolveOutput: ...

and register it:

    from solver.registry import register
    from myteam.cpsat import solve as cpsat_solve
    register("A", cpsat_solve)          # scenario-specific
    register("*", cpsat_solve)          # or as the new default for all

Nothing else in the codebase changes — the API contract, the CSV writers and
the whole React UI keep working.
"""

from __future__ import annotations

from typing import Callable, Dict

from .baseline import solve_baseline
from .policies import solve_a, solve_b, solve_c
from .schemas import InstanceData, SolveOutput

Solver = Callable[[str, InstanceData], SolveOutput]

_REGISTRY: Dict[str, Solver] = {
    "*": solve_baseline,
    "A": solve_a,
    "B": solve_b,
    "C": solve_c,
}


def register(scenario: str, solver: Solver) -> None:
    """Register (or override) the solver used for a scenario. '*' sets the default."""
    _REGISTRY[scenario.upper()] = solver


def get_solver(scenario: str) -> Solver:
    return _REGISTRY.get(scenario.upper(), _REGISTRY["*"])


def registered() -> Dict[str, str]:
    return {k: getattr(v, "__name__", repr(v)) for k, v in _REGISTRY.items()}


def solve_scenario(scenario_name: str, input_data: InstanceData) -> SolveOutput:
    """Dispatch to the registered solver for `scenario_name`."""
    scenario = (scenario_name or "A").strip().upper()
    if scenario not in ("A", "B", "C"):
        raise ValueError(f"Unknown scenario '{scenario_name}' — expected A, B or C.")
    return get_solver(scenario)(scenario, input_data)
