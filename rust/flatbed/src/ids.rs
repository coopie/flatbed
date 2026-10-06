//! Times and ids, from the standard library alone. Times are ISO 8601 strings in UTC; entry ids
//! are eight random hex characters; session ids are the time to the second plus four hex
//! characters, so a directory listing sorts by age.

use crate::error::{Error, Result};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::time::{SystemTime, UNIX_EPOCH};

/// Random bits, good enough for ids that only need to differ, not to be secret. Each
/// `RandomState` is seeded afresh by the standard library, which saves a dependency on `rand`.
fn random_u64() -> u64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(now_since_epoch().as_nanos());
    hasher.finish()
}

fn now_since_epoch() -> std::time::Duration {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is before 1970")
}

pub fn new_entry_id() -> String {
    format!("{:08x}", random_u64() as u32)
}

/// The time now, such as `2026-10-06T21:04:11.000Z`.
pub fn now_iso() -> String {
    iso(now_since_epoch().as_millis() as i64)
}

/// Formats milliseconds since 1970 as an ISO 8601 UTC string.
pub fn iso(millis: i64) -> String {
    let (days, ms_of_day) = (millis.div_euclid(86_400_000), millis.rem_euclid(86_400_000));
    let (year, month, day) = civil_from_days(days);
    let seconds = ms_of_day / 1000;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60,
        ms_of_day % 1000
    )
}

/// The calendar date of a day count since 1970-01-01, by Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// A session id such as `2026-10-06T21-04-11Z-a3f9`, made from `now` (an ISO string), which
/// sorts after `previous`. When the clock has not moved on since the previous id, it takes the
/// previous id's time and adds one to its hex part.
pub fn new_session_id(now: &str, previous: Option<&str>) -> Result<String> {
    let id = format!(
        "{}Z-{:04x}",
        now[..19].replace(':', "-"),
        random_u64() as u16
    );
    let Some(previous) = previous else {
        return Ok(id);
    };
    if id.as_str() > previous {
        return Ok(id);
    }
    let cut = previous.rfind('-').ok_or("A session id has no hex part.")?;
    let next = u32::from_str_radix(&previous[cut + 1..], 16)
        .map_err(|_| Error(format!("Cannot read the hex part of {previous}.")))?
        + 1;
    if next > 0xffff {
        return Err(Error(format!("Cannot make a session id after {previous}.")));
    }
    Ok(format!("{}-{next:04x}", &previous[..cut]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_times() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_791_320_651_512), "2026-10-06T21:04:11.512Z");
    }

    #[test]
    fn session_ids_sort_after_the_previous_one() {
        let now = "2026-10-06T21:04:11.000Z";
        assert!(new_session_id(now, None)
            .unwrap()
            .starts_with("2026-10-06T21-04-11Z-"));
        let later = "2026-10-06T21-05-00Z-0000";
        assert_eq!(
            new_session_id(now, Some(later)).unwrap(),
            "2026-10-06T21-05-00Z-0001"
        );
    }
}
