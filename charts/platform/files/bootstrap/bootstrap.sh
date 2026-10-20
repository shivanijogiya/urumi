#!/usr/bin/env bash
# Store bootstrap, step 1 of 2: the Job's `wp` initContainer (WP-CLI, uid 33, WordPress docroot
# mounted at /var/www/html). Idempotent: each step checks state first, so re-runs only fix drift.
#   1. wait for wp-config.php and the database
#   2. install WordPress            3. timezone + pretty permalinks
#   4. install/activate WooCommerce 5. store settings, pages, shipping, COD, public storefront
#   6. API user (shop_manager)      7. demo product
#   8. Application Password: keep the one in the API Secret if it still authenticates, else
#      replace it and write the new one to /shared/WOO_APP_PASSWORD (0600, in-memory volume)
# Never prints a secret: credentials come from env, the new password goes straight to a file.
set -euo pipefail
umask 077

for var in STORE_URL STORE_TITLE WOO_VERSION WOO_CURRENCY WOO_DEFAULT_COUNTRY WOO_URL WOO_USER \
  WOO_USER_EMAIL WP_ADMIN_USER WP_ADMIN_PASSWORD WP_ADMIN_EMAIL WORDPRESS_DB_HOST; do
  [ -n "${!var:-}" ] || {
    echo "ERROR: $var is not set" >&2
    exit 1
  }
done

DOCROOT=/var/www/html
EXISTING_DIR=/existing
NEW_PASSWORD_FILE=/shared/WOO_APP_PASSWORD
APP_PASSWORD_NAME=woo-mcp-gateway
DEMO_PRODUCT='Demo Tee'

say() { printf '==> %s\n' "$*"; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}
# WooCommerce's `wp wc ...` commands go through the REST API and need a user with permissions.
wpwc() { wp wc "$@" --user="$WP_ADMIN_USER"; }

# 1. wp-config.php is written by the WordPress pod's entrypoint on its first start.
say "Waiting for WordPress files"
for _ in $(seq 1 60); do
  [ -f "$DOCROOT/wp-config.php" ] && [ -f "$DOCROOT/wp-includes/version.php" ] && break
  sleep 5
done
[ -f "$DOCROOT/wp-config.php" ] || die "no $DOCROOT/wp-config.php after 5 min"

# PHP mysqli is what WordPress itself uses (`wp db check` shells out to mysqlcheck, whose TLS
# defaults differ). Credentials come from the env; nothing is printed.
say "Waiting for the database"
db_ok() {
  php -r '
    [$host, $port] = array_pad(explode(":", getenv("WORDPRESS_DB_HOST"), 2), 2, "3306");
    mysqli_report(MYSQLI_REPORT_OFF);
    $db = @mysqli_connect($host, getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"),
      getenv("WORDPRESS_DB_NAME"), (int) $port);
    exit($db ? 0 : 1);'
}
for _ in $(seq 1 36); do
  db_ok && break
  sleep 5
done
db_ok || die "database not reachable after 3 min"

# 2. WordPress. The admin password is fed on stdin (--prompt), so it is never in argv.
if wp core is-installed; then
  say "WordPress already installed"
else
  say "Installing WordPress"
  printf '%s\n' "$WP_ADMIN_PASSWORD" |
    wp core install --url="$STORE_URL" --title="$STORE_TITLE" --admin_user="$WP_ADMIN_USER" \
      --admin_email="$WP_ADMIN_EMAIL" --skip-email --prompt=admin_password >/dev/null
  wp core is-installed || die "wp core install did not complete"
  say "WordPress installed"
fi

# 3. "Today" for orders is store time (Asia/Kolkata). Pretty permalinks for /wp-json/.
wp option update timezone_string Asia/Kolkata
wp rewrite structure '/%postname%/' --hard

# 4. WooCommerce, pinned. A different installed version is replaced with the pin.
installed=$(wp plugin get woocommerce --field=version 2>/dev/null || true)
if [ "$installed" = "$WOO_VERSION" ]; then
  say "WooCommerce $WOO_VERSION already installed"
else
  say "Installing WooCommerce $WOO_VERSION (was: ${installed:-none})"
  wp plugin install woocommerce --version="$WOO_VERSION" --force
fi
wp plugin is-active woocommerce || wp plugin activate woocommerce
wp wc update

# 5. Store settings. The onboarding wizard is marked skipped so wp-admin opens normally.
say "Configuring WooCommerce"
wp option update woocommerce_currency "$WOO_CURRENCY"
wp option update woocommerce_default_country "$WOO_DEFAULT_COUNTRY"
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp option update woocommerce_allow_tracking no
wp transient delete _wc_activation_redirect >/dev/null 2>&1 || true
# "Coming soon" mode hides the storefront from visitors; the store must be public.
wp option update woocommerce_coming_soon no
wpwc tool run install_pages
# Physical products need a shipping method to check out: free shipping in the catch-all zone 0
# ("locations not covered by your other zones").
if wpwc shipping_zone_method list 0 --field=method_id | grep -qx free_shipping; then
  say "Free shipping already enabled"
else
  wpwc shipping_zone_method create 0 --method_id=free_shipping --enabled=true --porcelain >/dev/null
  say "Free shipping enabled"
fi
wp option update woocommerce_cod_settings --format=json \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}'

# 6. API user: least privilege (shop_manager), no known login password (a random one is
# generated and discarded); it authenticates only with its Application Password.
if wp user get "$WOO_USER" --field=ID >/dev/null 2>&1; then
  wp user set-role "$WOO_USER" shop_manager >/dev/null
  say "API user $WOO_USER exists (role shop_manager)"
else
  wp user create "$WOO_USER" "$WOO_USER_EMAIL" --role=shop_manager --porcelain >/dev/null
  say "API user $WOO_USER created (role shop_manager)"
fi

# 7. Something to buy (D1).
if [ -n "$(wp post list --post_type=product --post_status=any --title="$DEMO_PRODUCT" --field=ID)" ]; then
  say "Product '$DEMO_PRODUCT' exists"
else
  id=$(wpwc product create --name="$DEMO_PRODUCT" --type=simple --regular_price=499 --status=publish --porcelain)
  say "Product '$DEMO_PRODUCT' created (id $id)"
fi

# 8. Application Password.
if php /scripts/check-app-password.php "$EXISTING_DIR"; then
  say "Existing Application Password still authenticates; keeping it"
  exit 0
fi
say "Creating a new Application Password '$APP_PASSWORD_NAME' for $WOO_USER"
for uuid in $(wp user application-password list "$WOO_USER" --name="$APP_PASSWORD_NAME" --field=uuid); do
  wp user application-password delete "$WOO_USER" "$uuid" >/dev/null
done
password=$(wp user application-password create "$WOO_USER" "$APP_PASSWORD_NAME" --porcelain)
[ -n "$password" ] || die "application-password create returned nothing"
printf '%s' "$password" >"$NEW_PASSWORD_FILE.tmp"
mv "$NEW_PASSWORD_FILE.tmp" "$NEW_PASSWORD_FILE"
unset password
say "New Application Password written to the shared in-memory volume"
