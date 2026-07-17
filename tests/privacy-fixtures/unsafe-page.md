---
title: Deliberately Unsafe Fixture
record_type: specimen
collection_location_private: "Fake Creek gravel bar behind the old mill, Fakeville"
coordinates_private: "37.123456, -78.654321"
publish: true
---

# Deliberately Unsafe Fixture

This file exists so CI can prove the privacy scanner works WITHOUT access to the
private vault. It must live outside `content/` and must never be exported or built.
Every line below is fake and intentionally violates a rule the scanner must catch.

The sample was collected at latitude 37.123456, longitude -78.654321, near the
GPS waypoint we saved that afternoon.

DMS form for the same fake spot: 37° 7' 24" N, 78° 39' 16" W.

These decimals must NOT trip the scanner (negative controls): the specimen weighs
2.35 kg, measures 8.4 by 6.2 cm, has a density around 2.65 g/cm3, hardness 6.5,
and dates from roughly 251.9 to 66.0 million years ago.

## Private Notes

Test marker (deliberately different from the vault's real canary):
CANARY-ROCK-TEST-FIXTURE
