require "bundler/setup"
require "rails"
require "action_controller/railtie"
require "action_view/railtie"

module Fixture
  class Application < Rails::Application
    config.load_defaults 8.1
    config.root = File.expand_path("..", __dir__)
    config.eager_load = false
    config.consider_all_requests_local = true
    config.secret_key_base = "fixture-only-not-a-secret"
    config.public_file_server.enabled = true
    config.public_file_server.headers = { "cache-control" => "no-store" }
    config.logger = Logger.new($stdout)
    config.log_level = :warn
    config.hosts.clear

    # The e2e suite starts the app twice: with template annotations on, for
    # the Rails mapper, and off, for the side panel's suggestion.
    config.action_view.annotate_rendered_view_with_filenames = ENV["ANNOTATE_VIEWS"] == "1"
  end
end
