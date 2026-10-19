/**
 * בדיקת היתכנות: geocoding ואופטימיזציית מסלול של Google דרך Apps Script, בלי כרטיס אשראי.
 *
 * הרצה:
 * 1. https://script.google.com → New project (מחובר לחשבון Google רגיל).
 * 2. מוחקים את התוכן, מדביקים את הקובץ הזה, ושומרים (Ctrl+S).
 * 3. בוחרים runAll ברשימת הפונקציות למעלה ולוחצים Run. בפעם הראשונה צריך לאשר הרשאות.
 * 4. מעתיקים את כל ה-Execution log ומדביקים בחזרה לסשן.
 */

const CITY = ', בית שמש';
// אותן כתובות שנבדקו ב-OpenStreetMap, כדי שאפשר יהיה להשוות.
const ADDRESSES = [
  'הרצל 10', 'ביאליק 4', "ז'בוטינסקי 6", 'נחל דולב 5', 'נחל שורק 20',
  'נהר הירדן 15', 'נחל לכיש 12', 'נחל זוהר 30', 'הרב שלמה זלמן 10', 'חזון איש 8',
  'בן איש חי 5', 'האדמו"ר מבעלזא 3', 'ירמיהו הנביא 5', 'נחל הקישון 7', 'המלך דוד 2',
];
const START = 'תחנת רכבת בית שמש';

function runAll() {
  testGeocode();
  testRoute(ADDRESSES.length);
  // בדיקה מעבר ל-15: מכפילים כתובות עם מספר בית אחר, כדי לגלות את מגבלת העצירות.
  testRoute(23);
  testRoute(25);
}

function testGeocode() {
  const geocoder = Maps.newGeocoder().setRegion('il').setLanguage('iw');
  let exact = 0;
  ADDRESSES.forEach(function (a) {
    const r = geocoder.geocode(a + CITY);
    if (r.status !== 'OK') {
      Logger.log('GEOCODE ' + a + ' → ' + r.status);
      return;
    }
    const g = r.results[0].geometry;
    // ROOFTOP = מספר בית מדויק. RANGE_INTERPOLATED = הערכה לאורך הרחוב. GEOMETRIC_CENTER/APPROXIMATE = רחוב או אזור.
    if (g.location_type === 'ROOFTOP') exact++;
    Logger.log('GEOCODE ' + a + ' → ' + g.location_type + ' | ' + r.results[0].formatted_address +
      ' | ' + g.location.lat.toFixed(5) + ',' + g.location.lng.toFixed(5));
  });
  Logger.log('GEOCODE SUMMARY: ' + exact + '/' + ADDRESSES.length + ' ROOFTOP');
}

function testRoute(count) {
  const stops = [];
  for (let i = 0; i < count; i++) {
    const base = ADDRESSES[i % ADDRESSES.length];
    // מעבר לרשימה המקורית משנים את מספר הבית, כדי שלא יהיו עצירות כפולות.
    stops.push(i < ADDRESSES.length ? base : base.replace(/\d+/, function (n) { return String(Number(n) + 2); }));
  }
  const finder = Maps.newDirectionFinder()
    .setOrigin(START + CITY)
    .setDestination(START + CITY)
    .setMode(Maps.DirectionFinder.Mode.DRIVING)
    .setOptimizeWaypoints(true)
    .setLanguage('iw');
  stops.forEach(function (s) { finder.addWaypoint(s + CITY); });
  try {
    const res = finder.getDirections();
    if (res.status !== 'OK') {
      Logger.log('ROUTE ' + count + ' stops → ' + res.status + ' ' + (res.error_message || ''));
      return;
    }
    const route = res.routes[0];
    let meters = 0, seconds = 0;
    route.legs.forEach(function (l) { meters += l.distance.value; seconds += l.duration.value; });
    Logger.log('ROUTE ' + count + ' stops → OK | ' + (meters / 1000).toFixed(1) + ' km | ' +
      Math.round(seconds / 60) + ' min');
    Logger.log('ORDER: ' + route.waypoint_order.map(function (i) { return stops[i]; }).join(' → '));
  } catch (e) {
    Logger.log('ROUTE ' + count + ' stops → EXCEPTION ' + e.message);
  }
}
