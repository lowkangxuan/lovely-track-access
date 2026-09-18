"""Separate answer-key policies; shared physical constraints live in optimizer."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Policy:
    scenario: str
    excess: int | None
    eclo: bool
    strict_deadline: bool
    continuity: bool
    delay_cost: bool


STRICT_SUPPLY = Policy("A", 0, False, False, False, True)
STRICT_SCHEDULE = Policy("B", None, True, True, False, False)
BALANCED = Policy("C", 1, True, False, True, True)


def solve_a(scenario, data):
    from .optimizer import optimize
    return optimize(data, STRICT_SUPPLY)


def solve_b(scenario, data):
    from .optimizer import optimize
    return optimize(data, STRICT_SCHEDULE)


def solve_c(scenario, data):
    from .optimizer import optimize
    return optimize(data, BALANCED)
