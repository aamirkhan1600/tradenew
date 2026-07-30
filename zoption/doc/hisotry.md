Create a complete Node.js project using the latest yahoo-finance2 package.

Requirements:
1. Use JavaScript (ES Modules).
2. Install and configure yahoo-finance2.
3. Create a reusable service class named YahooFinanceService.
4. Implement the following methods:
   - getHistoricalData(symbol, interval, startDate, endDate)
   - getQuote(symbol)
   - searchStocks(query)
5. The getHistoricalData() method should support:
   - 1m
   - 2m
   - 5m
   - 15m
   - 30m
   - 60m
   - 90m
   - 1d
   - 1wk
   - 1mo
6. Return data in the following format:
   {
     date,
     open,
     high,
     low,
     close,
     volume
   }
7. Add proper async/await error handling.
8. Validate user inputs.
9. Use environment variables where necessary.
10. Create an Express API with these endpoints:
    GET /quote/:symbol
    GET /history/:symbol?interval=1d&start=2024-01-01&end=2024-12-31
    GET /search?q=reliance
11. Organize the project with this structure:

project/
├── src/
│   ├── services/
│   │   └── YahooFinanceService.js
│   ├── routes/
│   ├── controllers/
│   ├── app.js
│   └── server.js
├── package.json
├── .env.example
└── README.md

12. Use modern ES Module syntax.
13. Include complete source code for every file.
14. Add example API requests using curl and Postman.
15. Ensure the project is production-ready and easy to extend.  for histry data only 
