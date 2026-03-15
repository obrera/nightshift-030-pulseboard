import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ChangeEvent } from 'react'

type City = {
  id: string
  name: string
  country: string
  admin1?: string
  latitude: number
  longitude: number
  timezone: string
}

type Advisory = {
  label: string
  tone: string
  summary: string
  activities: string[]
}

type HourlyPoint = {
  time: string
  aqi: number | null
  temperature: number | null
  humidity: number | null
  wind: number | null
  precipitationProbability: number | null
  weatherCode: number | null
}

type CitySnapshot = {
  city: City
  fetchedAt: string
  current: HourlyPoint & {
    pm25: number | null
    pm10: number | null
    ozone: number | null
  }
  hourly: HourlyPoint[]
  advisory: Advisory
  alerts: string[]
  trend: 'Improving' | 'Steady' | 'Worsening'
  peakAqi: number | null
  avgAqi: number | null
}

type PersistedState = {
  savedCities: City[]
  activeCityId: string | null
  notes: Record<string, string>
}

type ImportPayload = PersistedState & {
  exportedAt?: string
  schemaVersion?: number
}

const STORAGE_KEY = 'nightshift-030-pulseboard'
const MAX_SAVED_CITIES = 3
const DEFAULT_CITY: City = {
  id: 'new-york-usa-40.71--74.01',
  name: 'New York',
  admin1: 'New York',
  country: 'United States',
  latitude: 40.7128,
  longitude: -74.006,
  timezone: 'America/New_York',
}

const badgeStyles = {
  Good: 'bg-emerald-400/15 text-emerald-200 ring-1 ring-inset ring-emerald-400/35',
  Fair: 'bg-lime-400/15 text-lime-200 ring-1 ring-inset ring-lime-400/35',
  Moderate: 'bg-amber-300/15 text-amber-100 ring-1 ring-inset ring-amber-300/35',
  Poor: 'bg-orange-400/15 text-orange-100 ring-1 ring-inset ring-orange-400/35',
  Severe: 'bg-rose-500/15 text-rose-100 ring-1 ring-inset ring-rose-500/35',
} as const

const weatherCodeMap: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  80: 'Rain showers',
  81: 'Heavy showers',
  82: 'Violent showers',
  95: 'Thunderstorm',
}

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

function cityLabel(city: City) {
  return [city.name, city.admin1, city.country].filter(Boolean).join(', ')
}

function cityIdFrom(result: {
  name: string
  country: string
  admin1?: string
  latitude: number
  longitude: number
}) {
  return `${result.name}-${result.admin1 ?? ''}-${result.country}-${result.latitude.toFixed(2)}-${result.longitude.toFixed(2)}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
}

function formatHour(time: string) {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(time))
}

function formatDate(time: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(time))
}

function dayKeyFromOffset(offset: number) {
  const now = new Date()
  now.setUTCHours(0, 0, 0, 0)
  now.setUTCDate(now.getUTCDate() + offset)
  return now.toISOString().slice(0, 10)
}

function labelFromAqi(aqi: number | null) {
  if (aqi === null) {
    return { label: 'Unavailable', tone: 'Slate' }
  }

  if (aqi <= 50) {
    return { label: 'Good', tone: 'Good' }
  }
  if (aqi <= 75) {
    return { label: 'Fair', tone: 'Fair' }
  }
  if (aqi <= 100) {
    return { label: 'Moderate', tone: 'Moderate' }
  }
  if (aqi <= 150) {
    return { label: 'Poor', tone: 'Poor' }
  }
  return { label: 'Severe', tone: 'Severe' }
}

function advisoryFromAqi(aqi: number | null): Advisory {
  if (aqi === null) {
    return {
      label: 'Data gap',
      tone: 'Slate',
      summary: 'Air quality data is temporarily unavailable. Treat outdoor plans conservatively.',
      activities: ['Choose indoor workouts', 'Check again in 30 minutes', 'Avoid smoke-intensive areas'],
    }
  }

  if (aqi <= 50) {
    return {
      label: 'Open-air green light',
      tone: 'Good',
      summary: 'Outdoor runs, bike commutes, and long walking blocks are in a low-risk range.',
      activities: ['Run or cycle outdoors', 'Ventilate indoor spaces', 'Schedule longer outdoor errands'],
    }
  }
  if (aqi <= 100) {
    return {
      label: 'Balanced exposure',
      tone: 'Moderate',
      summary: 'Most people can stay outside, but long hard efforts should be spaced out.',
      activities: ['Keep outdoor sessions moderate', 'Use lower-traffic routes', 'Hydrate before evening plans'],
    }
  }
  if (aqi <= 150) {
    return {
      label: 'Sensitive groups caution',
      tone: 'Poor',
      summary: 'Kids, older adults, and anyone with respiratory concerns should trim exposure windows.',
      activities: ['Swap intervals for light walks', 'Close windows overnight', 'Use an air purifier if available'],
    }
  }
  return {
    label: 'Indoor-first mode',
    tone: 'Severe',
    summary: 'Outdoor activity should be shortened or moved indoors until conditions recover.',
    activities: ['Move workouts inside', 'Wear a filtered mask outside', 'Avoid prolonged commuting exposure'],
  }
}

function average(values: Array<number | null>) {
  const valid = values.filter((value): value is number => value !== null)
  if (!valid.length) {
    return null
  }
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function buildAlerts(hourly: HourlyPoint[], currentAqi: number | null, peakAqi: number | null, trend: string) {
  const alerts: string[] = []
  const precipPeak = Math.max(...hourly.map((point) => point.precipitationProbability ?? 0))
  const windPeak = Math.max(...hourly.map((point) => point.wind ?? 0))

  if (currentAqi !== null && currentAqi > 100) {
    alerts.push(`AQI ${Math.round(currentAqi)} is in a reduced-activity range.`)
  }
  if (peakAqi !== null && peakAqi >= 150) {
    alerts.push(`24h peak AQI could reach ${Math.round(peakAqi)}.`)
  }
  if (trend === 'Worsening') {
    alerts.push('Air quality is trending upward over the next six hours.')
  }
  if (precipPeak >= 60) {
    alerts.push(`Rain disruption risk is elevated with precipitation odds up to ${Math.round(precipPeak)}%.`)
  }
  if (windPeak >= 30) {
    alerts.push(`Wind speeds may hit ${Math.round(windPeak)} km/h.`)
  }

  return alerts
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`)
  }
  return (await response.json()) as T
}

async function searchCities(query: string) {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
  url.searchParams.set('name', query)
  url.searchParams.set('count', '6')
  url.searchParams.set('language', 'en')
  url.searchParams.set('format', 'json')

  const payload = await fetchJson<{
    results?: Array<{
      name: string
      country: string
      admin1?: string
      latitude: number
      longitude: number
      timezone: string
    }>
  }>(url.toString())

  return (payload.results ?? []).map((result) => ({
    id: cityIdFrom(result),
    name: result.name,
    country: result.country,
    admin1: result.admin1,
    latitude: result.latitude,
    longitude: result.longitude,
    timezone: result.timezone,
  }))
}

async function fetchCitySnapshot(city: City): Promise<CitySnapshot> {
  const weatherUrl = new URL('https://api.open-meteo.com/v1/forecast')
  weatherUrl.searchParams.set('latitude', String(city.latitude))
  weatherUrl.searchParams.set('longitude', String(city.longitude))
  weatherUrl.searchParams.set('timezone', city.timezone || 'auto')
  weatherUrl.searchParams.set('forecast_days', '2')
  weatherUrl.searchParams.set(
    'current',
    'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m',
  )
  weatherUrl.searchParams.set(
    'hourly',
    'temperature_2m,relative_humidity_2m,precipitation_probability,weather_code,wind_speed_10m',
  )

  const airUrl = new URL('https://air-quality-api.open-meteo.com/v1/air-quality')
  airUrl.searchParams.set('latitude', String(city.latitude))
  airUrl.searchParams.set('longitude', String(city.longitude))
  airUrl.searchParams.set('timezone', city.timezone || 'auto')
  airUrl.searchParams.set('forecast_days', '2')
  airUrl.searchParams.set('current', 'us_aqi,pm2_5,pm10,ozone')
  airUrl.searchParams.set('hourly', 'us_aqi,pm2_5,pm10,ozone')

  const [weather, air] = await Promise.all([
    fetchJson<{
      current: {
        time: string
        temperature_2m: number
        relative_humidity_2m: number
        weather_code: number
        wind_speed_10m: number
      }
      hourly: {
        time: string[]
        temperature_2m: number[]
        relative_humidity_2m: number[]
        precipitation_probability: number[]
        weather_code: number[]
        wind_speed_10m: number[]
      }
    }>(weatherUrl.toString()),
    fetchJson<{
      current: {
        us_aqi: number | null
        pm2_5: number | null
        pm10: number | null
        ozone: number | null
      }
      hourly: {
        time: string[]
        us_aqi: Array<number | null>
      }
    }>(airUrl.toString()),
  ])

  const currentIndex = Math.max(weather.hourly.time.indexOf(weather.current.time), 0)
  const hourly = weather.hourly.time.slice(currentIndex, currentIndex + 24).map((time, index) => {
    const sourceIndex = currentIndex + index
    const airIndex = air.hourly.time.indexOf(time)

    return {
      time,
      aqi: airIndex >= 0 ? air.hourly.us_aqi[airIndex] : null,
      temperature: weather.hourly.temperature_2m[sourceIndex] ?? null,
      humidity: weather.hourly.relative_humidity_2m[sourceIndex] ?? null,
      wind: weather.hourly.wind_speed_10m[sourceIndex] ?? null,
      precipitationProbability:
        weather.hourly.precipitation_probability[sourceIndex] ?? null,
      weatherCode: weather.hourly.weather_code[sourceIndex] ?? null,
    }
  })

  const currentAqi = air.current.us_aqi ?? hourly[0]?.aqi ?? null
  const nextSixAverage = average(hourly.slice(0, 6).map((point) => point.aqi))
  const trendDelta = nextSixAverage !== null && currentAqi !== null ? nextSixAverage - currentAqi : 0
  const trend =
    trendDelta >= 8 ? 'Worsening' : trendDelta <= -8 ? 'Improving' : 'Steady'
  const peakAqi = hourly.reduce<number | null>((peak, point) => {
    if (point.aqi === null) {
      return peak
    }
    return peak === null ? point.aqi : Math.max(peak, point.aqi)
  }, null)

  return {
    city,
    fetchedAt: new Date().toISOString(),
    current: {
      time: weather.current.time,
      aqi: currentAqi,
      temperature: weather.current.temperature_2m,
      humidity: weather.current.relative_humidity_2m,
      wind: weather.current.wind_speed_10m,
      precipitationProbability: hourly[0]?.precipitationProbability ?? null,
      weatherCode: weather.current.weather_code,
      pm25: air.current.pm2_5 ?? null,
      pm10: air.current.pm10 ?? null,
      ozone: air.current.ozone ?? null,
    },
    hourly,
    advisory: advisoryFromAqi(currentAqi),
    alerts: buildAlerts(hourly, currentAqi, peakAqi, trend),
    trend,
    peakAqi,
    avgAqi: average(hourly.map((point) => point.aqi)),
  }
}

function App() {
  const [query, setQuery] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<City[]>([])
  const [searching, setSearching] = useState(false)
  const [loadingCityIds, setLoadingCityIds] = useState<string[]>([])
  const [savedCities, setSavedCities] = useState<City[]>(() => {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return [DEFAULT_CITY]
    }

    try {
      const parsed = JSON.parse(raw) as PersistedState
      return parsed.savedCities?.length ? parsed.savedCities.slice(0, MAX_SAVED_CITIES) : [DEFAULT_CITY]
    } catch {
      return [DEFAULT_CITY]
    }
  })
  const [activeCityId, setActiveCityId] = useState<string | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return DEFAULT_CITY.id
    }

    try {
      const parsed = JSON.parse(raw) as PersistedState
      return parsed.activeCityId ?? parsed.savedCities?.[0]?.id ?? DEFAULT_CITY.id
    } catch {
      return DEFAULT_CITY.id
    }
  })
  const [notes, setNotes] = useState<Record<string, string>>(() => {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }

    try {
      return (JSON.parse(raw) as PersistedState).notes ?? {}
    } catch {
      return {}
    }
  })
  const [selectedDay, setSelectedDay] = useState(dayKeyFromOffset(0))
  const [snapshots, setSnapshots] = useState<Record<string, CitySnapshot>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const deferredQuery = useDeferredValue(query.trim())

  async function loadSnapshot(city: City) {
    setLoadingCityIds((current) => [...new Set([...current, city.id])])
    setDataError(null)

    try {
      const snapshot = await fetchCitySnapshot(city)
      setSnapshots((current) => ({ ...current, [city.id]: snapshot }))
    } catch (error) {
      setDataError(`Unable to load live conditions for ${city.name}.`)
      console.error(error)
    } finally {
      setLoadingCityIds((current) => current.filter((id) => id !== city.id))
    }
  }

  async function runSearch(value: string) {
    if (value.length < 2) {
      startTransition(() => setSuggestions([]))
      setSearchError(null)
      return
    }

    setSearching(true)
    setSearchError(null)

    try {
      const results = await searchCities(value)
      startTransition(() => setSuggestions(results))
    } catch (error) {
      setSearchError('City search is unavailable right now.')
      console.error(error)
    } finally {
      setSearching(false)
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void runSearch(deferredQuery)
    }, 250)

    return () => window.clearTimeout(timeout)
  }, [deferredQuery])

  useEffect(() => {
    const missingCities = savedCities.filter((city) => !snapshots[city.id])
    missingCities.forEach((city) => {
      void loadSnapshot(city)
    })
  }, [savedCities, snapshots])

  useEffect(() => {
    const state: PersistedState = {
      savedCities,
      activeCityId,
      notes,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [activeCityId, notes, savedCities])

  const activeCity = useMemo(
    () => savedCities.find((city) => city.id === activeCityId) ?? savedCities[0] ?? null,
    [activeCityId, savedCities],
  )
  const activeSnapshot = activeCity ? snapshots[activeCity.id] : null
  const compareCities = savedCities.slice(0, MAX_SAVED_CITIES)
  const dayOptions = [0, 1, 2].map((offset) => {
    const key = dayKeyFromOffset(offset)
    return { key, label: offset === 0 ? 'Today' : formatDate(`${key}T00:00:00Z`) }
  })
  const noteKey = activeCity ? `${activeCity.id}:${selectedDay}` : ''

  function addSavedCity(city: City) {
    const alreadySaved = savedCities.some((entry) => entry.id === city.id)
    const atCapacity = savedCities.length >= MAX_SAVED_CITIES

    if (!alreadySaved && atCapacity) {
      setDataError(`Only ${MAX_SAVED_CITIES} cities can be saved at once.`)
      return
    }

    setSavedCities((current) => (current.some((entry) => entry.id === city.id) ? current : [...current, city]))
    setActiveCityId(city.id)
    setSuggestions([])
    setQuery(cityLabel(city))
    if (!snapshots[city.id]) {
      void loadSnapshot(city)
    }
  }

  function removeCity(cityId: string) {
    setSavedCities((current) => {
      const next = current.filter((city) => city.id !== cityId)
      const resolvedCities = next.length ? next : [DEFAULT_CITY]

      if (activeCityId === cityId) {
        setActiveCityId(resolvedCities[0]?.id ?? DEFAULT_CITY.id)
      }

      return resolvedCities
    })
  }

  function exportJson() {
    const payload: ImportPayload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      savedCities,
      activeCityId,
      notes,
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'nightshift-030-pulseboard.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const raw = await file.text()
      const parsed = JSON.parse(raw) as ImportPayload

      if (!Array.isArray(parsed.savedCities) || typeof parsed.notes !== 'object') {
        throw new Error('Invalid payload')
      }

      const nextCities = parsed.savedCities.slice(0, MAX_SAVED_CITIES)
      setSavedCities(nextCities.length ? nextCities : [DEFAULT_CITY])
      setActiveCityId(parsed.activeCityId ?? nextCities[0]?.id ?? DEFAULT_CITY.id)
      setNotes(parsed.notes ?? {})
      nextCities.forEach((city) => {
        void loadSnapshot(city)
      })
    } catch (error) {
      setDataError('Import failed. Use a PulseBoard JSON export.')
      console.error(error)
    } finally {
      event.target.value = ''
    }
  }

  return (
    <main className="min-h-screen overflow-x-clip bg-grid bg-[size:32px_32px] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-w-0 max-w-7xl flex-col gap-6">
        <section className="overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/70 shadow-glow backdrop-blur-xl">
          <div className="grid gap-8 px-6 py-8 lg:grid-cols-[1.25fr_0.75fr] lg:px-8">
            <div className="min-w-0 space-y-6">
              <div className="inline-flex max-w-full items-center rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.28em] text-cyan-200">
                Nightshift 030 PulseBoard
              </div>
              <div className="space-y-3">
                <h1 className="max-w-3xl text-balance break-words font-display text-4xl font-bold tracking-tight text-white sm:text-5xl">
                  Dark-mode air quality planning for fast city-to-city decisions.
                </h1>
                <p className="max-w-2xl break-words text-base text-slate-300 sm:text-lg">
                  Search cities, compare up to three saved locations, monitor live AQI and weather,
                  then lock in daily activity notes with exportable local persistence.
                </p>
              </div>

              <div className="relative max-w-2xl min-w-0">
                <label className="mb-2 block text-sm font-medium text-slate-300" htmlFor="city-search">
                  City search
                </label>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <input
                    id="city-search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search a city"
                    className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white outline-none transition focus:border-cyan-400/50 focus:bg-white/10"
                  />
                  <button
                    type="button"
                    onClick={() => activeCity && void loadSnapshot(activeCity)}
                    disabled={!activeCity}
                    className="rounded-2xl border border-cyan-400/30 bg-cyan-400/10 px-5 py-3 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Refresh active
                  </button>
                </div>

                {(searching || searchError || suggestions.length > 0) && (
                  <div className="absolute z-20 mt-3 w-full overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur-xl">
                    {searching && <p className="px-4 py-3 text-sm text-slate-300">Searching Open-Meteo...</p>}
                    {searchError && <p className="px-4 py-3 text-sm text-rose-200">{searchError}</p>}
                    {!searching && !searchError && suggestions.length === 0 && deferredQuery.length >= 2 && (
                      <p className="px-4 py-3 text-sm text-slate-400">No matching cities.</p>
                    )}
                    <ul>
                      {suggestions.map((city) => (
                        <li key={city.id} className="border-t border-white/5 first:border-t-0">
                          <button
                            type="button"
                            onClick={() => addSavedCity(city)}
                            className="flex w-full min-w-0 items-start justify-between gap-4 px-4 py-3 text-left transition hover:bg-white/5"
                          >
                            <span className="min-w-0">
                              <span className="block font-medium text-white">{city.name}</span>
                              <span className="block break-words text-sm text-slate-400">{cityLabel(city)}</span>
                            </span>
                            <span className="shrink-0 rounded-full border border-white/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-slate-300">
                              Add
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={exportJson}
                  className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10"
                >
                  Export JSON
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/10"
                >
                  Import JSON
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={handleImport}
                />
              </div>
            </div>

            <aside className="min-w-0 rounded-[1.75rem] border border-white/10 bg-white/5 p-5">
              <p className="text-sm uppercase tracking-[0.28em] text-slate-400">Planner rules</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                {[
                  'Save up to three cities for side-by-side AQI comparisons.',
                  'Use alerts to catch rising AQI spikes, wind, and rain disruption.',
                  'Write daily notes per city and keep them in localStorage or export JSON.',
                ].map((rule) => (
                  <div key={rule} className="rounded-2xl border border-white/10 bg-slate-950/70 p-4 text-sm text-slate-300">
                    {rule}
                  </div>
                ))}
              </div>
            </aside>
          </div>
        </section>

        {dataError && (
          <section className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {dataError}
          </section>
        )}

        <section className="grid gap-6 xl:grid-cols-[1.4fr_0.6fr]">
          <div className="min-w-0 space-y-6">
            <section className="rounded-[2rem] border border-white/10 bg-slate-950/70 p-6 shadow-glow backdrop-blur-xl">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <p className="text-sm uppercase tracking-[0.28em] text-slate-400">Active city</p>
                  <h2 className="mt-2 break-words font-display text-3xl font-bold text-white">
                    {activeCity ? cityLabel(activeCity) : 'No city selected'}
                  </h2>
                  {activeSnapshot && (
                    <p className="mt-2 text-sm text-slate-400">
                      Updated {formatHour(activeSnapshot.fetchedAt)} on {formatDate(activeSnapshot.fetchedAt)}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-3">
                  {activeCity && (
                    <button
                      type="button"
                      onClick={() => removeCity(activeCity.id)}
                      className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white transition hover:bg-white/10"
                    >
                      Remove city
                    </button>
                  )}
                </div>
              </div>

              {!activeSnapshot ? (
                <div className="mt-6 rounded-3xl border border-dashed border-white/15 bg-white/[0.03] p-8 text-sm text-slate-400">
                  {activeCity && loadingCityIds.includes(activeCity.id)
                    ? 'Loading live conditions...'
                    : 'Add or refresh a city to load conditions.'}
                </div>
              ) : (
                <div className="mt-6 min-w-0 space-y-6">
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    {[
                      {
                        label: 'US AQI',
                        value: activeSnapshot.current.aqi !== null ? Math.round(activeSnapshot.current.aqi) : 'N/A',
                        detail: activeSnapshot.advisory.label,
                      },
                      {
                        label: 'Temperature',
                        value:
                          activeSnapshot.current.temperature !== null
                            ? `${numberFormat.format(activeSnapshot.current.temperature)}°C`
                            : 'N/A',
                        detail: weatherCodeMap[activeSnapshot.current.weatherCode ?? -1] ?? 'Conditions pending',
                      },
                      {
                        label: 'Humidity',
                        value:
                          activeSnapshot.current.humidity !== null
                            ? `${numberFormat.format(activeSnapshot.current.humidity)}%`
                            : 'N/A',
                        detail: `Wind ${numberFormat.format(activeSnapshot.current.wind ?? 0)} km/h`,
                      },
                      {
                        label: '24h peak AQI',
                        value: activeSnapshot.peakAqi !== null ? Math.round(activeSnapshot.peakAqi) : 'N/A',
                        detail: `${activeSnapshot.trend} trend`,
                      },
                    ].map((metric) => (
                      <article key={metric.label} className="min-w-0 rounded-3xl border border-white/10 bg-white/[0.04] p-5">
                        <p className="text-sm uppercase tracking-[0.24em] text-slate-400">{metric.label}</p>
                        <p className="mt-3 text-4xl font-semibold text-white">{metric.value}</p>
                        <p className="mt-2 text-sm text-slate-300">{metric.detail}</p>
                      </article>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <span
                      className={`rounded-full px-3 py-1 text-sm font-semibold ${
                        badgeStyles[
                          labelFromAqi(activeSnapshot.current.aqi).tone as keyof typeof badgeStyles
                        ] ?? 'bg-slate-400/15 text-slate-100 ring-1 ring-inset ring-white/10'
                      }`}
                    >
                      {labelFromAqi(activeSnapshot.current.aqi).label}
                    </span>
                    <span className="rounded-full border border-white/10 px-3 py-1 text-sm text-slate-300">
                      PM2.5 {activeSnapshot.current.pm25 !== null ? numberFormat.format(activeSnapshot.current.pm25) : 'N/A'}
                    </span>
                    <span className="rounded-full border border-white/10 px-3 py-1 text-sm text-slate-300">
                      PM10 {activeSnapshot.current.pm10 !== null ? numberFormat.format(activeSnapshot.current.pm10) : 'N/A'}
                    </span>
                    <span className="rounded-full border border-white/10 px-3 py-1 text-sm text-slate-300">
                      Ozone {activeSnapshot.current.ozone !== null ? numberFormat.format(activeSnapshot.current.ozone) : 'N/A'}
                    </span>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
                    <article className="min-w-0 rounded-3xl border border-white/10 bg-slate-900/80 p-5">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm uppercase tracking-[0.24em] text-slate-400">24h hourly board</p>
                          <h3 className="mt-2 text-xl font-semibold text-white">AQI + weather next 24 hours</h3>
                        </div>
                      </div>
                      <div className="mt-4 flex gap-3 overflow-x-auto pb-2">
                        {activeSnapshot.hourly.map((point) => (
                          <div
                            key={point.time}
                            className="min-w-[140px] rounded-2xl border border-white/10 bg-white/[0.04] p-4"
                          >
                            <p className="text-sm font-medium text-slate-200">{formatHour(point.time)}</p>
                            <p className="mt-1 text-xs text-slate-400">{formatDate(point.time)}</p>
                            <p className="mt-4 text-3xl font-semibold text-white">
                              {point.aqi !== null ? Math.round(point.aqi) : '--'}
                            </p>
                            <div className="mt-3 space-y-1 text-sm text-slate-300">
                              <p>{point.temperature !== null ? `${numberFormat.format(point.temperature)}°C` : 'N/A'}</p>
                              <p>{point.precipitationProbability !== null ? `${Math.round(point.precipitationProbability)}% rain` : 'Rain N/A'}</p>
                              <p>{point.wind !== null ? `${Math.round(point.wind)} km/h wind` : 'Wind N/A'}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </article>

                    <article className="min-w-0 rounded-3xl border border-white/10 bg-slate-900/80 p-5">
                      <p className="text-sm uppercase tracking-[0.24em] text-slate-400">Alerts</p>
                      <h3 className="mt-2 text-xl font-semibold text-white">Operational watchlist</h3>
                      <div className="mt-4 space-y-3">
                        {activeSnapshot.alerts.length > 0 ? (
                          activeSnapshot.alerts.map((alert) => (
                            <div
                              key={alert}
                              className="rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-50"
                            >
                              {alert}
                            </div>
                          ))
                        ) : (
                          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-50">
                            No active alerts. Conditions are stable across the next 24 hours.
                          </div>
                        )}
                      </div>
                    </article>
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-[2rem] border border-white/10 bg-slate-950/70 p-6 shadow-glow backdrop-blur-xl">
              <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div>
                  <p className="text-sm uppercase tracking-[0.28em] text-slate-400">Compare cities</p>
                  <h2 className="mt-2 font-display text-2xl font-bold text-white">Saved city deck</h2>
                </div>
                <p className="text-sm text-slate-400">
                  {savedCities.length}/{MAX_SAVED_CITIES} saved
                </p>
              </div>
              <div className="mt-6 grid gap-4 lg:grid-cols-3">
                {compareCities.map((city) => {
                  const snapshot = snapshots[city.id]
                  const tone = snapshot ? labelFromAqi(snapshot.current.aqi).tone : 'Slate'
                  const label = snapshot ? labelFromAqi(snapshot.current.aqi).label : 'Loading'

                  return (
                    <button
                      type="button"
                      key={city.id}
                      onClick={() => setActiveCityId(city.id)}
                      className={`rounded-3xl border p-5 text-left transition ${
                        activeCityId === city.id
                          ? 'border-cyan-400/40 bg-cyan-400/10'
                          : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="break-words text-xl font-semibold text-white">{city.name}</h3>
                          <p className="mt-1 text-sm text-slate-400">{city.admin1 ?? city.country}</p>
                        </div>
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] ${
                            badgeStyles[tone as keyof typeof badgeStyles] ??
                            'bg-slate-400/15 text-slate-100 ring-1 ring-inset ring-white/10'
                          }`}
                        >
                          {label}
                        </span>
                      </div>
                      <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
                        <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-3">
                          <p className="text-slate-400">AQI</p>
                          <p className="mt-2 text-2xl font-semibold text-white">
                            {snapshot?.current.aqi !== null && snapshot?.current.aqi !== undefined
                              ? Math.round(snapshot.current.aqi)
                              : '--'}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-3">
                          <p className="text-slate-400">Trend</p>
                          <p className="mt-2 text-lg font-semibold text-white">{snapshot?.trend ?? 'Loading'}</p>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </section>
          </div>

          <aside className="min-w-0 space-y-6">
            <section className="rounded-[2rem] border border-white/10 bg-slate-950/70 p-6 shadow-glow backdrop-blur-xl">
              <p className="text-sm uppercase tracking-[0.28em] text-slate-400">Advisory planner</p>
              <h2 className="mt-2 font-display text-2xl font-bold text-white">
                {activeSnapshot?.advisory.label ?? 'Waiting for data'}
              </h2>
              <p className="mt-3 text-sm leading-6 text-slate-300">
                {activeSnapshot?.advisory.summary ??
                  'Select a city to generate air-quality guidance for the next operating window.'}
              </p>
              <div className="mt-5 space-y-3">
                {(activeSnapshot?.advisory.activities ?? []).map((activity) => (
                  <div key={activity} className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-slate-200">
                    {activity}
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[2rem] border border-white/10 bg-slate-950/70 p-6 shadow-glow backdrop-blur-xl">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm uppercase tracking-[0.28em] text-slate-400">Per-city notes</p>
                  <h2 className="mt-2 font-display text-2xl font-bold text-white">Daily plan</h2>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {dayOptions.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setSelectedDay(option.key)}
                    className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                      selectedDay === option.key
                        ? 'bg-cyan-400 text-slate-950'
                        : 'border border-white/10 bg-white/[0.04] text-white hover:bg-white/[0.08]'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <textarea
                value={noteKey ? notes[noteKey] ?? '' : ''}
                onChange={(event) =>
                  noteKey &&
                  setNotes((current) => ({
                    ...current,
                    [noteKey]: event.target.value,
                  }))
                }
                placeholder={
                  activeCity
                    ? `Write a note for ${activeCity.name} on ${selectedDay}`
                    : 'Select a city to start writing notes.'
                }
                className="mt-5 min-h-40 w-full rounded-3xl border border-white/10 bg-white/[0.04] px-4 py-4 text-sm text-white outline-none transition focus:border-cyan-400/40 focus:bg-white/[0.08]"
              />
            </section>
          </aside>
        </section>
      </div>
    </main>
  )
}

export default App
