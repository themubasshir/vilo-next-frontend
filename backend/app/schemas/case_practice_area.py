from enum import Enum


class CasePracticeArea(str, Enum):
    civil_litigation = "Civil Litigation"
    criminal = "Criminal Law"
    family = "Family Law"
    conveyancing = "Conveyancing"
    probate = "Probate & Estate"
    corporate = "Corporate / Commercial"
    employment = "Employment Law"
    personal_injury = "Personal Injury"
    immigration = "Immigration"
    real_estate = "Real Estate"
    other = "Other"
