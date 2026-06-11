/**
 * airports.ts — Airport waypoints for the sector map. The full set
 * (~500 large + medium airports) loads from /api/airports (OurAirports
 * data); the embedded major-hub list below is the offline fallback.
 */

/** A plotted airport waypoint. */
export interface Airport {
  /** IATA code shown as the map label. */
  iata: string;
  /** Full airport name shown in the hover tooltip. */
  name: string;
  /** City served, when known. */
  municipality?: string;
  latitude: number;
  longitude: number;
  /** 1 = major hub (always labeled), 2 = regional (labeled when zoomed). */
  rank?: 1 | 2;
}

/**
 * Loads the full airport set from the server, falling back to the
 * embedded major-hub list when the endpoint is unavailable.
 *
 * @returns Airports ready for the map layers.
 */
export async function loadAirports(): Promise<ReadonlyArray<Airport>> {
  try {
    const response = await fetch("/api/airports");
    if (!response.ok) return AIRPORTS;
    const body = (await response.json()) as { airports?: Airport[] };
    if (!Array.isArray(body.airports) || body.airports.length === 0) {
      return AIRPORTS;
    }
    return body.airports;
  } catch {
    return AIRPORTS;
  }
}

/** Airports plotted on the sector map (all within the CONUS bbox). */
export const AIRPORTS: ReadonlyArray<Airport> = [
  { iata: "ATL", name: "Hartsfield–Jackson Atlanta Intl", latitude: 33.6407, longitude: -84.4277 },
  { iata: "LAX", name: "Los Angeles Intl", latitude: 33.9416, longitude: -118.4085 },
  { iata: "ORD", name: "Chicago O'Hare Intl", latitude: 41.9742, longitude: -87.9073 },
  { iata: "DFW", name: "Dallas/Fort Worth Intl", latitude: 32.8998, longitude: -97.0403 },
  { iata: "DEN", name: "Denver Intl", latitude: 39.8561, longitude: -104.6737 },
  { iata: "JFK", name: "John F. Kennedy Intl", latitude: 40.6413, longitude: -73.7781 },
  { iata: "SFO", name: "San Francisco Intl", latitude: 37.6213, longitude: -122.379 },
  { iata: "SEA", name: "Seattle–Tacoma Intl", latitude: 47.4502, longitude: -122.3088 },
  { iata: "LAS", name: "Harry Reid Intl", latitude: 36.086, longitude: -115.1537 },
  { iata: "MCO", name: "Orlando Intl", latitude: 28.4312, longitude: -81.3081 },
  { iata: "MIA", name: "Miami Intl", latitude: 25.7959, longitude: -80.287 },
  { iata: "CLT", name: "Charlotte Douglas Intl", latitude: 35.2144, longitude: -80.9473 },
  { iata: "EWR", name: "Newark Liberty Intl", latitude: 40.6895, longitude: -74.1745 },
  { iata: "PHX", name: "Phoenix Sky Harbor Intl", latitude: 33.4343, longitude: -112.0117 },
  { iata: "IAH", name: "George Bush Intercontinental", latitude: 29.9902, longitude: -95.3368 },
  { iata: "BOS", name: "Boston Logan Intl", latitude: 42.3656, longitude: -71.0096 },
  { iata: "MSP", name: "Minneapolis–St. Paul Intl", latitude: 44.8848, longitude: -93.2223 },
  { iata: "DTW", name: "Detroit Metro Wayne County", latitude: 42.2162, longitude: -83.3554 },
  { iata: "FLL", name: "Fort Lauderdale–Hollywood Intl", latitude: 26.0742, longitude: -80.1506 },
  { iata: "LGA", name: "LaGuardia", latitude: 40.7769, longitude: -73.874 },
  { iata: "PHL", name: "Philadelphia Intl", latitude: 39.8744, longitude: -75.2424 },
  { iata: "SLC", name: "Salt Lake City Intl", latitude: 40.7899, longitude: -111.9791 },
  { iata: "BWI", name: "Baltimore/Washington Intl", latitude: 39.1774, longitude: -76.6684 },
  { iata: "DCA", name: "Ronald Reagan Washington Natl", latitude: 38.8512, longitude: -77.0402 },
  { iata: "IAD", name: "Washington Dulles Intl", latitude: 38.9531, longitude: -77.4565 },
  { iata: "SAN", name: "San Diego Intl", latitude: 32.7338, longitude: -117.1933 },
  { iata: "TPA", name: "Tampa Intl", latitude: 27.9755, longitude: -82.5332 },
  { iata: "AUS", name: "Austin–Bergstrom Intl", latitude: 30.1975, longitude: -97.6664 },
  { iata: "BNA", name: "Nashville Intl", latitude: 36.1263, longitude: -86.6774 },
  { iata: "MDW", name: "Chicago Midway Intl", latitude: 41.7868, longitude: -87.7522 },
  { iata: "STL", name: "St. Louis Lambert Intl", latitude: 38.7499, longitude: -90.3748 },
  { iata: "PDX", name: "Portland Intl", latitude: 45.5898, longitude: -122.5951 },
  { iata: "MCI", name: "Kansas City Intl", latitude: 39.2976, longitude: -94.7139 },
  { iata: "SMF", name: "Sacramento Intl", latitude: 38.6954, longitude: -121.5908 },
  { iata: "SJC", name: "San José Mineta Intl", latitude: 37.3639, longitude: -121.9289 },
  { iata: "SAT", name: "San Antonio Intl", latitude: 29.5337, longitude: -98.4698 },
  { iata: "MSY", name: "Louis Armstrong New Orleans Intl", latitude: 29.9934, longitude: -90.258 },
  { iata: "RDU", name: "Raleigh–Durham Intl", latitude: 35.8801, longitude: -78.788 },
  { iata: "PIT", name: "Pittsburgh Intl", latitude: 40.4919, longitude: -80.2329 },
  { iata: "CLE", name: "Cleveland Hopkins Intl", latitude: 41.4117, longitude: -81.8498 },
  { iata: "CVG", name: "Cincinnati/Northern Kentucky Intl", latitude: 39.0533, longitude: -84.6630 },
  { iata: "CMH", name: "John Glenn Columbus Intl", latitude: 39.9980, longitude: -82.8919 },
  { iata: "IND", name: "Indianapolis Intl", latitude: 39.7173, longitude: -86.2944 },
  { iata: "YYZ", name: "Toronto Pearson Intl", latitude: 43.6777, longitude: -79.6248 },
  { iata: "YVR", name: "Vancouver Intl", latitude: 49.1967, longitude: -123.1815 },
  { iata: "YUL", name: "Montréal–Trudeau Intl", latitude: 45.4706, longitude: -73.7408 },
];
