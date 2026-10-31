/**
 * The WordPress plugin for one website chat widget (WEBSITE_CHAT.md §WordPress): a zip with one PHP
 * file that prints the widget in the footer. The widget key and script address are written in; the
 * identity secret is NEVER — the site's administrator pastes it into the plugin's own settings page,
 * so the download can be shared without giving the secret away.
 *
 * With the secret set and "identify signed-in customers" ticked, a logged-in WordPress user is signed
 * on the server: hash = HMAC-SHA256(secret, user id), and phoneHash = HMAC-SHA256(secret,
 * "phone:<id>:<phone>") for a WooCommerce billing phone.
 */

const php = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export function wordpressPluginFiles(input: { scriptUrl: string; widgetKey: string; widgetName: string }): Array<{ name: string; data: Buffer }> {
  const main = `<?php
/**
 * Plugin Name: Get Assist Chat
 * Description: Adds the "${input.widgetName.replace(/\*\//g, "")}" website chat widget to every page.
 * Version: 1.1.0
 * Requires PHP: 7.4
 * Requires at least: 5.8
 * License: Proprietary
 */

if (!defined('ABSPATH')) {
    exit;
}

define('GETASSIST_CHAT_SCRIPT', '${php(input.scriptUrl)}');
define('GETASSIST_CHAT_KEY', '${php(input.widgetKey)}');

// 1.1.0 keeps every 1.0.0 option name, so an update keeps the secret and the switches already set.
add_action('admin_init', function () {
    register_setting('getassist_chat', 'getassist_chat_secret', array('type' => 'string', 'sanitize_callback' => 'sanitize_text_field', 'default' => ''));
    register_setting('getassist_chat', 'getassist_chat_identify', array('type' => 'boolean', 'default' => false));
    register_setting('getassist_chat', 'getassist_chat_disabled', array('type' => 'boolean', 'default' => false));
    register_setting('getassist_chat', 'getassist_chat_hide_paths', array('type' => 'string', 'sanitize_callback' => 'getassist_chat_clean_paths', 'default' => ''));
    register_setting('getassist_chat', 'getassist_chat_hide_admins', array('type' => 'boolean', 'default' => false));
});

/** One path per line: /about (that page) or /blog/* (the blog and everything under it). Anything else is dropped. */
function getassist_chat_clean_paths($value) {
    $out = array();
    foreach (preg_split('/\\r\\n|\\r|\\n/', (string) $value) as $line) {
        $line = trim($line);
        if ($line !== '' && preg_match('#^/[A-Za-z0-9\\-._~%/]*\\*?$#', $line) && count($out) < 50) {
            $out[] = $line;
        }
    }
    return implode("\\n", $out);
}

/** Whether this request's path is one the site owner hid the chat on. */
function getassist_chat_hidden_here() {
    $rules = trim((string) get_option('getassist_chat_hide_paths'));
    if ($rules === '') {
        return false;
    }
    $path = strtolower(rtrim((string) wp_parse_url(isset($_SERVER['REQUEST_URI']) ? wp_unslash($_SERVER['REQUEST_URI']) : '/', PHP_URL_PATH), '/'));
    if ($path === '') {
        $path = '/';
    }
    foreach (explode("\\n", strtolower($rules)) as $rule) {
        $rule = trim($rule);
        if (substr($rule, -1) === '*') {
            $base = rtrim(substr($rule, 0, -1), '/');
            if ($path === $base || strpos($path, $base . '/') === 0) {
                return true;
            }
        } elseif (rtrim($rule, '/') === $path || ($rule === '/' && $path === '/')) {
            return true;
        }
    }
    return false;
}

add_action('admin_menu', function () {
    add_options_page('Get Assist Chat', 'Get Assist Chat', 'manage_options', 'getassist-chat', 'getassist_chat_settings_page');
});

add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($links) {
    array_unshift($links, '<a href="' . esc_url(admin_url('options-general.php?page=getassist-chat')) . '">Settings</a>');
    return $links;
});

function getassist_chat_settings_page() {
    if (!current_user_can('manage_options')) {
        return;
    }
    ?>
    <div class="wrap">
        <h1>Get Assist Chat</h1>
        <form method="post" action="options.php">
            <?php settings_fields('getassist_chat'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row">Show the chat</th>
                    <td>
                        <label><input type="checkbox" name="getassist_chat_disabled" value="1" <?php checked(get_option('getassist_chat_disabled')); ?> /> Hide the chat on this site</label><br />
                        <label><input type="checkbox" name="getassist_chat_hide_admins" value="1" <?php checked(get_option('getassist_chat_hide_admins')); ?> /> Hide it for logged-in site administrators</label>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="getassist_chat_hide_paths">Hide on these pages</label></th>
                    <td>
                        <textarea id="getassist_chat_hide_paths" name="getassist_chat_hide_paths" rows="4" class="large-text code"><?php echo esc_textarea(get_option('getassist_chat_hide_paths')); ?></textarea>
                        <p class="description">One per line: <code>/about</code> hides that page, <code>/blog/*</code> the blog and everything under it. The look, greeting and other page rules are set in Get Assist.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="getassist_chat_secret">Identity secret</label></th>
                    <td>
                        <input type="password" id="getassist_chat_secret" name="getassist_chat_secret" class="regular-text" value="<?php echo esc_attr(get_option('getassist_chat_secret')); ?>" autocomplete="off" />
                        <p class="description">From Get Assist: Settings &rarr; Messaging Channels &rarr; this widget &rarr; Identity secret. Optional.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row">Signed-in customers</th>
                    <td><label><input type="checkbox" name="getassist_chat_identify" value="1" <?php checked(get_option('getassist_chat_identify')); ?> /> Show logged-in customers to the team as verified (needs the secret)</label></td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}

add_action('wp_footer', function () {
    if (get_option('getassist_chat_disabled') || getassist_chat_hidden_here()) {
        return;
    }
    if (get_option('getassist_chat_hide_admins') && current_user_can('manage_options')) {
        return;
    }
    $secret = (string) get_option('getassist_chat_secret');
    if (get_option('getassist_chat_identify') && $secret !== '' && is_user_logged_in()) {
        $user = wp_get_current_user();
        $id = (string) $user->ID;
        $data = array(
            'id' => $id,
            'name' => $user->display_name,
            'email' => $user->user_email,
            'hash' => hash_hmac('sha256', $id, $secret),
        );
        $phone = (string) get_user_meta($user->ID, 'billing_phone', true);
        if ($phone !== '') {
            $data['phone'] = $phone;
            $data['phoneHash'] = hash_hmac('sha256', 'phone:' . $id . ':' . $phone, $secret);
        }
        echo '<script>window.GetAssistChat = ' . wp_json_encode(array('user' => $data)) . ';</script>';
    }
    printf('<script src="%s" data-key="%s" async></script>', esc_url(GETASSIST_CHAT_SCRIPT), esc_attr(GETASSIST_CHAT_KEY));
}, 100);
`;
  const readme = `=== Get Assist Chat ===
Stable tag: 1.1.0
Requires PHP: 7.4
Requires at least: 5.8

Adds the Get Assist website chat widget to every page.

== Installation ==
1. Plugins > Add New > Upload Plugin, choose this zip, Install, Activate.
2. Make sure this site's address is listed under the widget's "Security & domains" in Get Assist.
3. Optional: Settings > Get Assist Chat, paste the identity secret and tick "Show logged-in customers as verified".
   WooCommerce customers' billing phone is signed too, so the team can see their orders.
4. In Get Assist, press "Verify installation" on the widget's Installation tab.

== Changelog ==
= 1.1.0 =
* Hide the chat on chosen pages, or for logged-in administrators.
* Settings link on the Plugins page; options removed when the plugin is deleted.
* Uploading this over 1.0.0 keeps your settings.
`;
  // Deleting the plugin from WordPress removes its options (the secret included); deactivating keeps them.
  const uninstall = `<?php
if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}
foreach (array('getassist_chat_secret', 'getassist_chat_identify', 'getassist_chat_disabled', 'getassist_chat_hide_paths', 'getassist_chat_hide_admins') as $option) {
    delete_option($option);
}
`;
  return [
    { name: "getassist-chat/getassist-chat.php", data: Buffer.from(main, "utf8") },
    { name: "getassist-chat/uninstall.php", data: Buffer.from(uninstall, "utf8") },
    { name: "getassist-chat/readme.txt", data: Buffer.from(readme, "utf8") },
  ];
}
