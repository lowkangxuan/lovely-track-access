from datetime import date
import io
import ssl
import unittest
from unittest.mock import patch
import urllib.error

import weather_service


class WeatherTransportTests(unittest.TestCase):
    def test_fetch_with_missing_system_ca_bundle_keeps_tls_verification(self):
        # Reproduce Python installations whose default trust store is empty.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        self.assertEqual(context.cert_store_stats()["x509_ca"], 0)
        payload = b'{"daily":{"time":["2025-01-04"],"weather_code":[3],"precipitation_sum":[0]}}'
        with patch.object(weather_service.ssl, "create_default_context", return_value=context), \
                patch.object(weather_service.urllib.request, "urlopen", return_value=io.BytesIO(payload)) as open_url:
            result = weather_service.fetch_daily(
                weather_service.ARCHIVE_URL, 1.3521, 103.8198,
                date(2025, 1, 4), date(2025, 1, 4),
            )

        used_context = open_url.call_args.kwargs["context"]
        self.assertGreater(used_context.cert_store_stats()["x509_ca"], 0)
        self.assertEqual(used_context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(used_context.check_hostname)
        self.assertEqual(result["daily"]["time"], ["2025-01-04"])

    def test_certificate_failure_still_blocks_uncached_outlook(self):
        failure = urllib.error.URLError(ssl.SSLCertVerificationError("untrusted certificate"))
        with patch.object(weather_service.urllib.request, "urlopen", side_effect=failure) as open_url:
            with self.assertRaisesRegex(weather_service.WeatherUnavailable, "no cached weather"):
                weather_service.fetch_outlook(
                    1.3521, 103.8198, date(2025, 1, 4), date(2025, 1, 4),
                    today=date(2025, 1, 4),
                )
        self.assertEqual(open_url.call_count, 1)


if __name__ == "__main__":
    unittest.main()
