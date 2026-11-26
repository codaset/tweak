class PagesController < ApplicationController
  def home
    @plans = [{ name: "Starter", price: 9 }, { name: "Team", price: 29 }]
  end
end
