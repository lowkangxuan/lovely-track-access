"""Compatibility entry point for the closure-safe constructive scheduler.

The default registry fallback uses the same weekly closure constraints and
output validation as the CP-SAT incumbent. Keep the legacy public signature
for callers that still pass an iteration budget.
"""
from .schemas import InstanceData, SolveOutput


def solve_baseline(scenario: str, data: InstanceData, iterations: int = 14) -> SolveOutput:
    from .network import Calendar, Network, build_activity_plans
    from .optimizer import _greedy, _output, _quality
    from .policies import BALANCED, STRICT_SCHEDULE, STRICT_SUPPLY

    policies = {"A": STRICT_SUPPLY, "B": STRICT_SCHEDULE, "C": BALANCED}
    scenario = scenario.strip().upper()
    if scenario not in policies:
        raise ValueError(f"Unknown scenario '{scenario}' — expected A, B or C.")
    policy = policies[scenario]
    cal = Calendar(data.parameters.horizon_start, data.parameters.horizon_weeks)
    net = Network.build(data)
    plans = build_activity_plans(data, net, cal)
    candidates = [
        _output(data, policy, _greedy(data, p, plans, net, cal, mode))
        for p in ([policy, STRICT_SUPPLY] if scenario == "C" else [policy])
        for mode in range(3)
    ]
    best = min(candidates, key=_quality)
    best.detail.update(solver="greedy-baseline", search_status="constructive")
    return best
