import { Link } from "react-router-dom";
import { Article } from "../components/Article";

export function HelpUnauthorized() {
  return (
    <Article
      title="Unauthorized transfers"
      lead="If someone moved money without your permission, there is a separate process for it."
    >
      <p>
        An unauthorized transfer is one that you didn't start and didn't give anyone permission to start. These reports
        go to our fraud team and follow a different process, with different protections, from mistaken transfers.
      </p>

      <h2>What counts as unauthorized</h2>
      <p>
        A transfer is unauthorized when, for example, someone used your login or device without your knowledge. A
        transfer that you started yourself is not unauthorized, even if you sent it to the wrong person or entered the
        wrong amount. That is a mistaken transfer, and it should be reported as one.
      </p>

      <h2>How to report an unauthorized transfer</h2>
      <p>
        Use the Report an unauthorized transfer form on the <Link to="/support#unauthorized-transfer">Support page</Link>.
        You'll need to:
      </p>
      <ul>
        <li>identify the transfer by its reference number, or by its date and amount;</li>
        <li>tell us the date you first noticed it; and</li>
        <li>tell us whether you have secured your account, for example by changing your password.</li>
      </ul>
      <p>
        Please don't describe a transfer you made yourself as unauthorized. Reports are reviewed, and inaccurate reports
        can delay genuine cases.
      </p>

      <h2>While you wait</h2>
      <p>
        Change your password and review your recent activity. If you notice other transfers you don't recognize, include
        them in your report or <Link to="/support">contact support</Link>.
      </p>
    </Article>
  );
}
